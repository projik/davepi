'use strict';

/**
 * HMAC-signed `state` parameter for the OAuth redirect dance.
 *
 * The `state` query parameter is the standard OAuth CSRF defence — it
 * travels with the user to the provider and comes back unchanged in
 * the callback. We need to be able to (a) bind it to *this* server
 * (HMAC) and (b) carry small payloads (the post-login redirect, the
 * already-logged-in userId for the link flow).
 *
 * Format: base64url(JSON({ nonce, ts, returnTo?, linkedUserId? })) +
 * '.' + base64url(HMAC-SHA256(payload, secret)). Verification
 * timing-safe-compares the MAC and rejects payloads older than
 * `maxAgeMs` (default 10 minutes).
 */

const crypto = require('crypto');

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToBuffer(str) {
  if (typeof str !== 'string') throw new Error('not a string');
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmac(secret, payloadB64) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest();
}

function signState(payload, { secret }) {
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    throw new Error('davepi-plugin-oauth: state secret must be at least 16 chars');
  }
  const body = {
    ...payload,
    nonce: payload.nonce || crypto.randomBytes(16).toString('hex'),
    ts: Date.now(),
  };
  const payloadB64 = b64urlEncode(JSON.stringify(body));
  const mac = b64urlEncode(hmac(secret, payloadB64));
  return `${payloadB64}.${mac}`;
}

function verifyState(token, { secret, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new Error('invalid state: malformed');
  }
  const dot = token.indexOf('.');
  const payloadB64 = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  const expectedMac = hmac(secret, payloadB64);
  let providedMac;
  try {
    providedMac = b64urlDecodeToBuffer(macB64);
  } catch (_) {
    throw new Error('invalid state: bad mac encoding');
  }
  if (providedMac.length !== expectedMac.length ||
      !crypto.timingSafeEqual(providedMac, expectedMac)) {
    throw new Error('invalid state: bad signature');
  }
  let body;
  try {
    body = JSON.parse(b64urlDecodeToBuffer(payloadB64).toString('utf8'));
  } catch (_) {
    throw new Error('invalid state: bad payload');
  }
  if (typeof body.ts !== 'number' || Date.now() - body.ts > maxAgeMs) {
    throw new Error('invalid state: expired');
  }
  return body;
}

module.exports = {
  signState,
  verifyState,
  b64urlEncode,
  b64urlDecodeToBuffer,
  DEFAULT_MAX_AGE_MS,
};
