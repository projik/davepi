'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildKey, slugifyName, userIdOfKey } = require('../lib/keys');

test('buildKey: produces <userId>/<8-hex>/<safeName> shape', () => {
  const key = buildKey({ userId: 'abc123', originalName: 'avatar.png' });
  // Expect three slash-separated segments.
  const parts = key.split('/');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'abc123');
  assert.match(parts[1], /^[0-9a-f]{8}$/);
  assert.equal(parts[2], 'avatar.png');
});

test('buildKey: missing originalName falls back to "file"', () => {
  const key = buildKey({ userId: 'u' });
  assert.match(key, /^u\/[0-9a-f]{8}\/file$/);
});

test('buildKey: rejects when userId is missing', () => {
  assert.throws(() => buildKey({ originalName: 'x.png' }), /userId/);
});

test('buildKey: collisions are vanishingly unlikely across 1000 runs', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const k = buildKey({ userId: 'u' });
    assert.equal(seen.has(k), false, `collision on iteration ${i}: ${k}`);
    seen.add(k);
  }
});

test('slugifyName: strips path components + non-safe chars', () => {
  assert.equal(slugifyName('My Report (final).pdf'), 'My_Report_final_.pdf');
  assert.equal(slugifyName('../etc/passwd'), 'passwd');
  assert.equal(slugifyName('C:\\Users\\hacker\\thing.exe'), 'thing.exe');
  assert.equal(slugifyName(''), 'file');
  assert.equal(slugifyName(null), 'file');
});

test('slugifyName: caps length so a 4KB filename does not blow the key', () => {
  const huge = 'x'.repeat(5000) + '.png';
  const out = slugifyName(huge);
  assert.ok(out.length <= 128, `expected ≤128, got ${out.length}`);
});

test('userIdOfKey: extracts the leading userId segment', () => {
  assert.equal(userIdOfKey('abc/12345678/file.png'), 'abc');
  assert.equal(userIdOfKey('no-slash'), null);
  assert.equal(userIdOfKey(''), null);
  assert.equal(userIdOfKey(null), null);
});
