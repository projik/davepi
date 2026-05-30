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
  makeSkillsFetcher,
  makeMemoryFetcher,
  makeProfileFetcher,
  promptCachingEnabled,
  buildModelInput,
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

test('memory fetcher reads list_agentMemory; null when no agentKey', async () => {
  const stub = personaMcpStub([{ agentKey: 'support', body: 'mem' }]);
  assert.equal(makeMemoryFetcher({ config: { agent: {} }, mcpClient: stub }), null);
  const fetch = makeMemoryFetcher({ config: { agent: { key: 'support' } }, mcpClient: stub, channelCtx: {} });
  const row = await fetch();
  assert.deepEqual(row, { agentKey: 'support', body: 'mem' });
  assert.equal(stub.calls[0].name, 'list_agentMemory');
  assert.equal(stub.calls[0].args.filter.agentKey, 'support');
});

test('skills fetcher reads list_skill filtered to approved; null when no agentKey', async () => {
  const rows = [{ _id: 's1', name: 'Refund', status: 'approved' }];
  const stub = personaMcpStub(rows);
  assert.equal(makeSkillsFetcher({ config: { agent: {} }, mcpClient: stub }), null);
  const fetch = makeSkillsFetcher({
    config: { agent: { key: 'support' } },
    mcpClient: stub,
    channelCtx: {},
  });
  const out = await fetch();
  assert.deepEqual(out, rows); // resolves to the full array, not the first row
  assert.equal(stub.calls[0].name, 'list_skill');
  assert.equal(stub.calls[0].args.filter.agentKey, 'support');
  // Approved-only is what keeps draft/deprecated runbooks out of the prompt.
  assert.equal(stub.calls[0].args.filter.status, 'approved');
});

test('skills fetcher returns [] on an empty result or an error envelope', async () => {
  const empty = personaMcpStub([]);
  const fetchEmpty = makeSkillsFetcher({
    config: { agent: { key: 'support' } },
    mcpClient: empty,
    channelCtx: {},
  });
  assert.deepEqual(await fetchEmpty(), []);

  const erroring = {
    async callTool() {
      return { isError: true, content: [{ type: 'text', text: 'boom' }] };
    },
  };
  const fetchErr = makeSkillsFetcher({
    config: { agent: { key: 'support' } },
    mcpClient: erroring,
    channelCtx: {},
  });
  assert.deepEqual(await fetchErr(), []);
});

test('profile fetcher keys on the channel-prefixed endUserKey; null in service mode', async () => {
  const stub = personaMcpStub([{ endUserKey: 'slack:U1', preferences: 'email' }]);
  assert.equal(makeProfileFetcher({ mcpClient: stub, channelCtx: { channelUserId: null } }), null);
  const fetch = makeProfileFetcher({ mcpClient: stub, channelCtx: { channel: 'slack', channelUserId: 'U1' } });
  const row = await fetch();
  assert.deepEqual(row, { endUserKey: 'slack:U1', preferences: 'email' });
  assert.equal(stub.calls[0].name, 'list_customerProfile');
  // Canonical key matches the schema example / backend tests (`slack:U1`).
  assert.equal(stub.calls[0].args.filter.endUserKey, 'slack:U1');
});

test('promptCachingEnabled: on for anthropic by default, off for other providers', () => {
  assert.equal(promptCachingEnabled({ llm: {} }), true);
  assert.equal(promptCachingEnabled({ llm: { provider: 'anthropic' } }), true);
  assert.equal(promptCachingEnabled({ llm: { provider: 'anthropic', promptCaching: false } }), false);
  assert.equal(promptCachingEnabled({ llm: { provider: 'openai' } }), false);
});

test('buildModelInput places a cacheControl system message ahead of the turns', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const cached = buildModelInput({ system: 'PREFIX', messages, caching: true });
  assert.equal(cached.system, undefined);
  assert.equal(cached.messages[0].role, 'system');
  assert.equal(cached.messages[0].content, 'PREFIX');
  assert.deepEqual(cached.messages[0].providerOptions, {
    anthropic: { cacheControl: { type: 'ephemeral' } },
  });
  assert.deepEqual(cached.messages.slice(1), messages);

  // Caching off: system stays a top-level string, messages untouched.
  const plain = buildModelInput({ system: 'PREFIX', messages, caching: false });
  assert.equal(plain.system, 'PREFIX');
  assert.deepEqual(plain.messages, messages);
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
