'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveResources,
  shouldRoute,
  filterToolsForActiveResource,
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

test('filterToolsForActiveResource picks tools whose name contains the resource', () => {
  const filtered = filterToolsForActiveResource(sampleTools, 'order');
  assert.equal(filtered.length, 5);
  assert.ok(filtered.every((t) => t.name.includes('order')));
});

test('filterToolsForActiveResource returns empty when no resource is active', () => {
  assert.deepEqual(filterToolsForActiveResource(sampleTools, null), []);
});

test('use_resource updates router state and returns activated tools', async () => {
  const buckets = deriveResources(sampleTools);
  const state = { activeResource: null };
  const tools = buildRouterTools({ resources: buckets, state });
  const out = await tools.use_resource.execute({ name: 'order' });
  assert.equal(state.activeResource, 'order');
  assert.equal(out.resource, 'order');
  assert.deepEqual(out.activated_tools.sort(), [
    'create_order',
    'delete_order',
    'get_order',
    'list_order',
    'update_order',
  ]);
});

test('use_resource returns an error for an unknown resource', async () => {
  const buckets = deriveResources(sampleTools);
  const state = { activeResource: null };
  const tools = buildRouterTools({ resources: buckets, state });
  const out = await tools.use_resource.execute({ name: 'invoice' });
  assert.match(out.error, /Unknown resource/);
  assert.equal(state.activeResource, null);
});
