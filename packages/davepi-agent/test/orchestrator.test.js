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

const { adaptMcpTools, normalizeMcpResult } = require('../lib/orchestrator');

const fakeJsonSchema = (schema) => ({ __schema: schema });

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

test('orchestrator surfaces UNLINKED errors as a link prompt without throwing', async () => {
  const { runTurn } = require('../lib/orchestrator');
  // mcpClient.listTools is called first; throwing UNLINKED there is the
  // realistic shape (auth.headersFor is invoked inside listTools).
  const unlinked = Object.assign(new Error('not linked'), { code: 'UNLINKED', linkUrl: 'http://link.example.com/login' });
  const mcpClient = {
    async listTools() { throw unlinked; },
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
  assert.match(out.text, /link.example\.com/);
  const final = events.find((e) => e.type === 'final');
  assert.ok(final);
});
