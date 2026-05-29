'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openStore, memoryStore, fileStore } = require('../lib/store');

test('memoryStore: round-trip + delete', async () => {
  const s = memoryStore();
  assert.equal(await s.get('a', 'b'), null);
  const row = await s.upsert({ channel: 'a', channel_user_id: 'b', refresh_token: 'rt' });
  assert.equal(row.refresh_token, 'rt');
  assert.ok(row.created_at);
  assert.ok(row.updated_at);
  await s.delete('a', 'b');
  assert.equal(await s.get('a', 'b'), null);
});

test('fileStore: persists across instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-agent-'));
  const fp = path.join(dir, 'store.json');
  const a = fileStore(fp);
  await a.upsert({ channel: 'http', channel_user_id: 'u1', refresh_token: 'rt' });
  await a.close();
  const b = fileStore(fp);
  const row = await b.get('http', 'u1');
  assert.equal(row.refresh_token, 'rt');
  await b.close();
});

test('fileStore: atomic — concurrent upserts both land', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-agent-'));
  const fp = path.join(dir, 'store.json');
  const s = fileStore(fp);
  await Promise.all([
    s.upsert({ channel: 'http', channel_user_id: 'u1', refresh_token: 'rt1' }),
    s.upsert({ channel: 'http', channel_user_id: 'u2', refresh_token: 'rt2' }),
    s.upsert({ channel: 'slack', channel_user_id: 'u1', refresh_token: 'rt3' }),
  ]);
  const r1 = await s.get('http', 'u1');
  const r2 = await s.get('http', 'u2');
  const r3 = await s.get('slack', 'u1');
  assert.equal(r1.refresh_token, 'rt1');
  assert.equal(r2.refresh_token, 'rt2');
  assert.equal(r3.refresh_token, 'rt3');
  await s.close();
});

test('openStore: routes memory: and file: schemes; legacy sqlite: maps to file', () => {
  const mem = openStore('memory:');
  assert.ok(mem.get && mem.upsert);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-agent-'));
  const f = openStore(`file:${path.join(dir, 'a.json')}`);
  assert.ok(f.get && f.upsert);
  const legacy = openStore(`sqlite:${path.join(dir, 'b.sqlite')}`);
  assert.ok(legacy.get && legacy.upsert);
});

test('openStore: rejects unknown schemes', () => {
  assert.throws(() => openStore('postgres://localhost/x'), /Unsupported STORE_URL scheme/);
});
