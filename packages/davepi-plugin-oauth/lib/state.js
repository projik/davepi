'use strict';

/**
 * Encrypted, authenticated `state` parameter for the OAuth redirect
 * dance.
 *
 * The `state` query parameter is the standard OAuth CSRF defence — it
 * travels with the user to the provider and comes back unchanged in
 * the callback. We need it to (a) bind to *this* server (integrity),
 * (b) keep its contents secret from observers of the front-channel
 * URL (confidentiality), and (c) carry small payloads we recover at
 * the callback (the post-login redirect hint, the linked-user id for
 * the link flow, and crucially the PKCE `code_verifier`).
 *
 * Earlier iterations used base64url(JSON) + HMAC. That is
 * tamper-proof but NOT confidential — an attacker who observes the
 * authorize URL can decode the JSON and recover the verifier,
 * defeating PKCE's interception-mitigation purpose. We now use
 * AES-256-GCM authenticated encryption: a single 32-byte key derived
 * from `OAUTH_STATE_SECRET` via SHA-256 gives us both integrity
 * (the GCM auth tag) and confidentiality (AES) in one primitive, no
 * separate HMAC step.
 *
 * Wire format: base64url(iv ‖ ciphertext ‖ tag), where iv is 12 random
 * bytes and tag is 16 bytes. The payload's `ts` field is checked
 * against `maxAgeMs` (default 10 minutes) after decryption.
 *
 * `signState` / `verifyState` are kept as aliases for `sealState` /
 * `openState` so callers and tests written against the earlier
 * iteration keep working — the semantics are stronger now, not
 * weaker.
 */

const crypto = require('crypto');

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
const IV_LEN = 12;
const TAG_LEN = 16;

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToBuffer(str) {
  if (typeof str !== 'string') throw new Error('not a string');
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function deriveKey(secret) {
  // 32 bytes for AES-256. SHA-256 is a fine KDF for a single-purpose
  // key derived from a long random secret; HKDF would be appropriate
  // if the same secret were reused across primitives.
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function sealState(payload, { secret } = {}) {
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    throw new Error('davepi-plugin-oauth: state secret must be at least 16 chars');
  }
  const body = {
    ...payload,
    nonce: payload.nonce || crypto.randomBytes(16).toString('hex'),
    ts: Date.now(),
  };
  const plaintext = Buffer.from(JSON.stringify(body), 'utf8');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return b64urlEncode(Buffer.concat([iv, ciphertext, tag]));
}

function openState(token, { secret, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (typeof token !== 'string' || !token.length) {
    throw new Error('invalid state: malformed');
  }
  let buf;
  try {
    buf = b64urlDecodeToBuffer(token);
  } catch (_) {
    throw new Error('invalid state: bad encoding');
  }
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('invalid state: too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_) {
    // Single error message for every authenticated-encryption
    // failure: wrong secret, tampered ciphertext, tampered tag, all
    // indistinguishable by design.
    throw new Error('invalid state: authentication failed');
  }
  let body;
  try {
    body = JSON.parse(plaintext.toString('utf8'));
  } catch (_) {
    throw new Error('invalid state: bad payload');
  }
  if (typeof body.ts !== 'number' || Date.now() - body.ts > maxAgeMs) {
    throw new Error('invalid state: expired');
  }
  return body;
}

module.exports = {
  sealState,
  openState,
  // Kept as aliases — the contract (tamper-proof token carrying a
  // payload) is unchanged; the implementation just got stronger.
  signState: sealState,
  verifyState: openState,
  b64urlEncode,
  b64urlDecodeToBuffer,
  DEFAULT_MAX_AGE_MS,
};
