'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { generateVerifier, challengeFor, generatePair } = require('../lib/pkce');

test('generateVerifier returns a base64url string between 43 and 128 chars', () => {
  const v = generateVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/);
  assert.ok(v.length >= 43 && v.length <= 128, `verifier length ${v.length} out of range`);
});

test('two verifiers are not equal (entropy sanity check)', () => {
  const a = generateVerifier();
  const b = generateVerifier();
  assert.notEqual(a, b);
});

test('challengeFor(verifier) matches the SHA-256(verifier) base64url', () => {
  const v = 'a-known-verifier-value';
  const expected = crypto.createHash('sha256').update(v).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challengeFor(v), expected);
});

test('generatePair returns { verifier, challenge, method: "S256" }', () => {
  const pair = generatePair();
  assert.equal(pair.method, 'S256');
  assert.equal(challengeFor(pair.verifier), pair.challenge);
});
