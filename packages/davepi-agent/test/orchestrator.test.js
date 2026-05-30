'use strict';

/**
 * Orchestrator tests. The Vercel AI SDK's streamText is not stubbed
 * out at the module level — instead we exercise just the
 * adaptMcpTools + normalizeMcpResult surface, plus the router-state
 * narrowing that runTurn depends on. Full streamText integration is
 * covered by the integration test that boots a real davepi.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adaptMcpTools,
  normalizeMcpResult,
  makePersonaFetcher,
  _resetPersonaCache,
} = require('../lib/orchestrator');

const fakeJsonSchema = (schema) => ({ __schema: schema });

// Build an mcpClient stub that returns a `list_agentPersona` payload in
// the MCP text-content shape and counts how many times it's called.
const personaMcpStub = (rows) => {
  const calls = [];
  return {
    calls,
    async callTool(name, args, ctx) {
      calls.push({ name, args, ctx });
      return { content: [{ type: 'text', text: JSON.stringify({ results: rows, totalResults: rows.length }) }] };
    },
  };
};

test('adaptMcpTools wraps each MCP tool with a parameters schema and an execute fn', () => {
  const captured = [];
  const mcpClient = {
    async callTool(name, args) {
      captured.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, name }) }] };
    },
  };
  const tools = [
    { name: 'list_order', description: 'List orders', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'get_order', description: 'Get one order', inputSchema: { type: 'object' } },
  ];
  const adapted = adaptMcpTools(tools, mcpClient, { channel: 'http' }, fakeJsonSchema);
  assert.equal(Object.keys(adapted).length, 2);
  assert.equal(adapted.list_order.description, 'List orders');
  assert.deepEqual(adapted.list_order.parameters.__schema.type, 'object');
});

test('adaptMcpTools execute() forwards args to mcpClient and parses JSON text content', async () => {
  const captured = [];
  const mcpClient = {
    async callTool(name, args) {
      captured.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify({ records: [1, 2, 3] }) }] };
    },
  };
  const adapted = adaptMcpTools(
    [{ name: 'list_order', inputSchema: { type: 'object' } }],
    mcpClient,
    { channel: 'http', channelUserId: 'u1' },
    fakeJsonSchema
  );
  const out = await adapted.list_order.execute({ limit: 5 });
  assert.deepEqual(out, { records: [1, 2, 3] });
  assert.deepEqual(captured, [{ name: 'list_order', args: { limit: 5 } }]);
});

test('normalizeMcpResult unwraps text JSON, plain text, and error envelopes', () => {
  assert.deepEqual(
    normalizeMcpResult({ content: [{ type: 'text', text: JSON.stringify({ a: 1 }) }] }),
    { a: 1 }
  );
  assert.deepEqual(
    normalizeMcpResult({ content: [{ type: 'text', text: 'plain text' }] }),
    { text: 'plain text' }
  );
  const err = normalizeMcpResult({ isError: true, content: [{ type: 'text', text: 'oops' }] });
  assert.equal(err.error, true);
  assert.deepEqual(err.content, ['oops']);
});

test('orchestrator surfaces UnlinkedError as a link prompt without throwing', async () => {
  const { runTurn } = require('../lib/orchestrator');
  const { UnlinkedError } = require('../lib/errors');
  const mcpClient = {
    async listTools() { throw new UnlinkedError('http://link.example.com/link/abc'); },
    async callTool() { throw new Error('should not be called'); },
  };
  const events = [];
  const out = await runTurn({
    config: { tools: { limit: 40, includeRender: false }, llm: { maxSteps: 1 } },
    model: null,
    mcpClient,
    channelCtx: { channel: 'http', channelUserId: 'u-x' },
    history: [],
    userMessage: 'show me my orders',
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.unlinked, true);
  assert.match(out.text, /link\.example\.com\/link\/abc/);
  const final = events.find((e) => e.type === 'final');
  assert.ok(final);
});

test('makePersonaFetcher returns null when no agentKey is configured', () => {
  _resetPersonaCache();
  const fetcher = makePersonaFetcher({ config: { agent: {} }, mcpClient: personaMcpStub([]) });
  assert.equal(fetcher, null);
});

test('persona is fetched once across turns within the TTL', async () => {
  _resetPersonaCache();
  const stub = personaMcpStub([{ agentKey: 'support', identity: 'Ada' }]);
  const config = { agent: { key: 'support', personaCacheTtlSeconds: 300 } };
  const fetcher = makePersonaFetcher({ config, mcpClient: stub, channelCtx: { channel: 'http' } });

  // Simulate three turns.
  const a = await fetcher();
  const b = await fetcher();
  const c = await fetcher();

  assert.equal(stub.calls.length, 1); // one MCP call total
  assert.equal(stub.calls[0].name, 'list_agentPersona');
  assert.deepEqual(a, { agentKey: 'support', identity: 'Ada' });
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test('a null (no-persona) result is cached too', async () => {
  _resetPersonaCache();
  const stub = personaMcpStub([]); // no rows
  const config = { agent: { key: 'empty', personaCacheTtlSeconds: 300 } };
  const fetcher = makePersonaFetcher({ config, mcpClient: stub, channelCtx: {} });

  assert.equal(await fetcher(), null);
  assert.equal(await fetcher(), null);
  assert.equal(stub.calls.length, 1);
});

test('personaCacheTtlSeconds: 0 disables caching (fetch every turn)', async () => {
  _resetPersonaCache();
  const stub = personaMcpStub([{ agentKey: 'support', identity: 'Ada' }]);
  const config = { agent: { key: 'support', personaCacheTtlSeconds: 0 } };
  const fetcher = makePersonaFetcher({ config, mcpClient: stub, channelCtx: {} });

  await fetcher();
  await fetcher();
  await fetcher();
  assert.equal(stub.calls.length, 3);
});

test('an expired entry triggers a refetch', async () => {
  _resetPersonaCache();
  const stub = personaMcpStub([{ agentKey: 'support', identity: 'Ada' }]);
  // 0.01s TTL so a short wait expires it.
  const config = { agent: { key: 'support', personaCacheTtlSeconds: 0.01 } };
  const fetcher = makePersonaFetcher({ config, mcpClient: stub, channelCtx: {} });

  await fetcher();
  assert.equal(stub.calls.length, 1);
  await new Promise((r) => setTimeout(r, 25));
  await fetcher();
  assert.equal(stub.calls.length, 2);
});

test('distinct agentKeys are cached independently', async () => {
  _resetPersonaCache();
  const stub = personaMcpStub([{ identity: 'X' }]);
  const support = makePersonaFetcher({
    config: { agent: { key: 'support', personaCacheTtlSeconds: 300 } },
    mcpClient: stub,
    channelCtx: {},
  });
  const sales = makePersonaFetcher({
    config: { agent: { key: 'sales', personaCacheTtlSeconds: 300 } },
    mcpClient: stub,
    channelCtx: {},
  });

  await support();
  await support();
  await sales();
  await sales();
  assert.equal(stub.calls.length, 2); // one per distinct agentKey
  assert.deepEqual(stub.calls.map((c) => c.args.filter.agentKey).sort(), ['sales', 'support']);
});
