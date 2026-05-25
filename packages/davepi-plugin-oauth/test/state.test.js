'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sealState, openState, signState, verifyState, b64urlDecodeToBuffer } = require('../lib/state');

const SECRET = 'a'.repeat(32);

test('sealState + openState round-trip preserves payload (minus internals)', () => {
  const token = sealState({ returnTo: '/dashboard', linkedUserId: null }, { secret: SECRET });
  const decoded = openState(token, { secret: SECRET });
  assert.equal(decoded.returnTo, '/dashboard');
  assert.equal(decoded.linkedUserId, null);
  assert.equal(typeof decoded.nonce, 'string');
  assert.equal(typeof decoded.ts, 'number');
});

test('signState / verifyState are aliases (back-compat with earlier iteration)', () => {
  const token = signState({ provider: 'google' }, { secret: SECRET });
  const decoded = verifyState(token, { secret: SECRET });
  assert.equal(decoded.provider, 'google');
});

test('openState rejects a tampered ciphertext (GCM auth tag fails)', () => {
  const token = sealState({ returnTo: '/a' }, { secret: SECRET });
  // Flip a single byte in the encrypted blob (mid-ciphertext, well
  // away from the IV and tag boundaries).
  const buf = b64urlDecodeToBuffer(token);
  buf[Math.floor(buf.length / 2)] ^= 0xff;
  const tampered = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.throws(() => openState(tampered, { secret: SECRET }), /authentication failed/);
});

test('openState rejects a token sealed with a different secret', () => {
  const token = sealState({}, { secret: SECRET });
  assert.throws(
    () => openState(token, { secret: 'b'.repeat(32) }),
    /authentication failed/
  );
});

test('openState rejects an expired token', () => {
  const token = sealState({}, { secret: SECRET });
  assert.throws(
    () => openState(token, { secret: SECRET, maxAgeMs: -1 }),
    /expired/
  );
});

test('openState rejects malformed / too-short tokens', () => {
  assert.throws(() => openState('', { secret: SECRET }), /malformed/);
  assert.throws(() => openState(123, { secret: SECRET }), /malformed/);
  // 16 bytes is shorter than IV(12) + TAG(16) + at-least-one ciphertext byte.
  const tooShort = Buffer.alloc(16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.throws(() => openState(tooShort, { secret: SECRET }), /too short|authentication/);
});

test('sealState rejects short secrets', () => {
  assert.throws(() => sealState({}, { secret: 'short' }), /at least 16/);
});

test('sealState carries PKCE verifier through the round-trip', () => {
  const token = sealState({ verifier: 'v123', provider: 'google' }, { secret: SECRET });
  const decoded = openState(token, { secret: SECRET });
  assert.equal(decoded.verifier, 'v123');
  assert.equal(decoded.provider, 'google');
});

test('PKCE verifier in sealed state is NOT recoverable from the token alone', () => {
  // This is the security property — a front-channel observer who
  // does not hold OAUTH_STATE_SECRET must not be able to extract the
  // verifier. base64-decoding the token and grepping for the
  // verifier substring is the dumbest possible attempt; assert it
  // fails. An earlier HMAC-only implementation would expose the
  // verifier in plaintext-JSON inside the base64.
  const verifier = 'pkce-verifier-secret-must-stay-opaque';
  const token = sealState({ provider: 'google', verifier }, { secret: SECRET });
  const decoded = b64urlDecodeToBuffer(token).toString('binary');
  assert.equal(decoded.includes(verifier), false,
    'verifier must not appear verbatim in the encrypted state');
});

test('two seals of the same payload produce distinct tokens (random IV)', () => {
  const a = sealState({ x: 1 }, { secret: SECRET });
  const b = sealState({ x: 1 }, { secret: SECRET });
  assert.notEqual(a, b);
});
