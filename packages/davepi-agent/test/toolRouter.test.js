'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveResources,
  shouldRoute,
  buildRouterTools,
} = require('../lib/toolRouter');

const sampleTools = [
  { name: 'list_order' },
  { name: 'get_order' },
  { name: 'create_order' },
  { name: 'update_order' },
  { name: 'delete_order' },
  { name: 'list_customer' },
  { name: 'get_customer' },
  { name: 'create_customer' },
  { name: 'search_product' },
  { name: 'count_product' },
];

function fakeMcpClient(captured) {
  return {
    async callTool(name, args) {
      captured.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, name }) }] };
    },
  };
}

test('deriveResources buckets by CRUD prefix', () => {
  const buckets = deriveResources(sampleTools);
  const names = buckets.map((b) => b.resource).sort();
  assert.deepEqual(names, ['customer', 'order', 'product']);
  const order = buckets.find((b) => b.resource === 'order');
  assert.equal(order.tools.length, 5);
});

test('shouldRoute respects the limit', () => {
  assert.equal(shouldRoute(10, 40), false);
  assert.equal(shouldRoute(41, 40), true);
});

test('list_resources returns each resource with its tool names', async () => {
  const captured = [];
  const tools = buildRouterTools({
    resources: deriveResources(sampleTools),
    state: { activeResource: null },
    mcpClient: fakeMcpClient(captured),
  });
  const out = await tools.list_resources.execute({});
  const order = out.resources.find((r) => r.name === 'order');
  assert.equal(order.tool_count, 5);
  assert.ok(order.tools.includes('list_order'));
});

test('use_resource flips active resource and surfaces allowed tools', async () => {
  const state = { activeResource: null };
  const tools = buildRouterTools({
    resources: deriveResources(sampleTools),
    state,
    mcpClient: fakeMcpClient([]),
  });
  const out = await tools.use_resource.execute({ name: 'order' });
  assert.equal(state.activeResource, 'order');
  assert.deepEqual(out.allowed_tools.sort(), [
    'create_order',
    'delete_order',
    'get_order',
    'list_order',
    'update_order',
  ]);
});

test('use_resource on an unknown name returns an error and leaves state alone', async () => {
  const state = { activeResource: null };
  const tools = buildRouterTools({
    resources: deriveResources(sampleTools),
    state,
    mcpClient: fakeMcpClient([]),
  });
  const out = await tools.use_resource.execute({ name: 'invoice' });
  assert.match(out.error, /Unknown resource/);
  assert.equal(state.activeResource, null);
});

test('call_mcp_tool refuses before a resource is chosen', async () => {
  const captured = [];
  const tools = buildRouterTools({
    resources: deriveResources(sampleTools),
    state: { activeResource: null },
    mcpClient: fakeMcpClient(captured),
  });
  const out = await tools.call_mcp_tool.execute({ name: 'list_order', args: {} });
  assert.match(out.error, /No resource is active/);
  assert.equal(captured.length, 0);
});

test('call_mcp_tool refuses tools that do not belong to the active resource', async () => {
  const captured = [];
  const state = { activeResource: 'order' };
  const tools = buildRouterTools({
    resources: deriveResources(sampleTools),
    state,
    mcpClient: fakeMcpClient(captured),
  });
  const out = await tools.call_mcp_tool.execute({ name: 'list_customer', args: {} });
  assert.match(out.error, /does not belong to the active resource/);
  assert.equal(captured.length, 0);
});

test('call_mcp_tool forwards valid invocations through the MCP client', async () => {
  const captured = [];
  const state = { activeResource: 'order' };
  const tools = buildRouterTools({
    resources: deriveResources(sampleTools),
    state,
    mcpClient: fakeMcpClient(captured),
    channelCtx: { channel: 'http' },
  });
  const out = await tools.call_mcp_tool.execute({ name: 'get_order', args: { id: 'abc' } });
  assert.deepEqual(captured, [{ name: 'get_order', args: { id: 'abc' } }]);
  assert.deepEqual(out, { ok: true, name: 'get_order' });
});
