'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { signState, verifyState } = require('../lib/state');

const SECRET = 'a'.repeat(32);

test('signState + verifyState round-trip preserves payload (minus internals)', () => {
  const token = signState({ returnTo: '/dashboard', linkedUserId: null }, { secret: SECRET });
  const decoded = verifyState(token, { secret: SECRET });
  assert.equal(decoded.returnTo, '/dashboard');
  assert.equal(decoded.linkedUserId, null);
  assert.equal(typeof decoded.nonce, 'string');
  assert.equal(typeof decoded.ts, 'number');
});

test('verifyState rejects a tampered payload (signature mismatch)', () => {
  const token = signState({ returnTo: '/a' }, { secret: SECRET });
  const [payload, sig] = token.split('.');
  // Flip the last char of the payload's base64url; sig won't match.
  const tampered = `${payload.slice(0, -1)}X.${sig}`;
  assert.throws(() => verifyState(tampered, { secret: SECRET }), /bad signature|bad payload/);
});

test('verifyState rejects a token signed with a different secret', () => {
  const token = signState({}, { secret: SECRET });
  assert.throws(
    () => verifyState(token, { secret: 'b'.repeat(32) }),
    /bad signature/
  );
});

test('verifyState rejects an expired token', () => {
  const token = signState({}, { secret: SECRET });
  assert.throws(
    () => verifyState(token, { secret: SECRET, maxAgeMs: -1 }),
    /expired/
  );
});

test('verifyState rejects malformed tokens', () => {
  assert.throws(() => verifyState('not.a.valid', { secret: SECRET }), /bad/);
  assert.throws(() => verifyState('no-dot', { secret: SECRET }), /malformed/);
  assert.throws(() => verifyState(123, { secret: SECRET }), /malformed/);
});

test('signState rejects short secrets', () => {
  assert.throws(() => signState({}, { secret: 'short' }), /at least 16/);
});

test('signState carries PKCE verifier through the round-trip', () => {
  const token = signState({ verifier: 'v123', provider: 'google' }, { secret: SECRET });
  const decoded = verifyState(token, { secret: SECRET });
  assert.equal(decoded.verifier, 'v123');
  assert.equal(decoded.provider, 'google');
});
