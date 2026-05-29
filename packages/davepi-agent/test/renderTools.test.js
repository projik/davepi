'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRenderTools } = require('../lib/renderTools');
const { tableToBlocks, chartToBlocks } = require('../lib/channels/slack');

test('render_table emits a structured table payload', async () => {
  const captured = [];
  const tools = buildRenderTools({ onRender: (p) => captured.push(p) });
  const out = await tools.render_table.execute({
    title: 'Orders',
    columns: ['id', { key: 'total', label: 'Total ($)' }],
    rows: [{ id: 1, total: 9.99 }, { id: 2, total: 12.5 }],
  });
  assert.equal(out.type, 'table');
  assert.equal(out.title, 'Orders');
  assert.equal(out.columns.length, 2);
  assert.equal(out.columns[1].label, 'Total ($)');
  assert.equal(out.rows.length, 2);
  assert.equal(captured.length, 1);
});

test('render_chart emits a vega-lite payload', async () => {
  const tools = buildRenderTools({});
  const spec = {
    mark: 'bar',
    encoding: { x: { field: 'a' }, y: { field: 'b', type: 'quantitative' } },
  };
  const out = await tools.render_chart.execute({ title: 'Daily', vegaLiteSpec: spec });
  assert.equal(out.type, 'chart');
  assert.deepEqual(out.vegaLiteSpec, spec);
});

test('slack tableToBlocks renders narrow tables as a single section', () => {
  const blocks = tableToBlocks({
    title: 'Open Orders',
    columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }],
    rows: [{ id: 1, name: 'first' }, { id: 2, name: 'second' }],
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'section');
  assert.match(blocks[0].text.text, /Open Orders/);
  assert.match(blocks[0].text.text, /ID \| Name/);
});

test('slack tableToBlocks falls back to a code block for wide tables (>10 cols)', () => {
  const columns = Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `c${i}` }));
  const blocks = tableToBlocks({ columns, rows: [] });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text.text, /^```\n/);
});

test('slack chartToBlocks builds a QuickChart image URL', () => {
  const blocks = chartToBlocks({
    title: 'Trend',
    vegaLiteSpec: { mark: 'line', data: { values: [{ x: 1, y: 2 }] } },
  });
  const image = blocks.find((b) => b.type === 'image');
  assert.ok(image);
  assert.match(image.image_url, /^https:\/\/quickchart\.io\/chart\?c=/);
});
