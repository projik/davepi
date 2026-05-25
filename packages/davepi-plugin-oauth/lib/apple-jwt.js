'use strict';

/**
 * Apple's "Sign in with Apple" requires a JWT-signed client secret
 * instead of a static string. The JWT is signed with ES256 (ECDSA
 * over P-256 with SHA-256), using a .p8 private key downloaded from
 * the Apple Developer console.
 *
 * The lifetime cap is six months (15777000 seconds). We default to 1
 * hour because the secret is generated per-request and there's no
 * benefit to a longer one.
 *
 * Node's crypto.createSign('SHA256').sign(key) returns the signature
 * in DER (ASN.1 SEQUENCE OF { r, s }) but JWT requires raw R || S,
 * fixed 64 bytes for P-256. We convert manually so the package stays
 * zero-runtime-dep (no `jsonwebtoken` import).
 */

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert a DER-encoded ECDSA signature to the IEEE P1363 / JOSE raw
 * form: r || s, each padded to keyByteLength (32 for P-256).
 *
 * DER layout:
 *   30 <total-len> 02 <r-len> <r-bytes> 02 <s-len> <s-bytes>
 *
 * `<r-bytes>` may have a leading 0x00 byte to keep r positive in
 * DER's signed-integer encoding — strip it. Or it may be shorter
 * than 32 bytes — left-pad with zeros.
 */
function derToJose(der, keyByteLength = 32) {
  if (der[0] !== 0x30) throw new Error('apple-jwt: signature not DER SEQUENCE');
  // Skip seq header
  let offset = 2;
  // Some implementations use a long-form length when total > 127 — for
  // P-256 the total is always <= 71, so the short form holds. We still
  // guard.
  if (der[1] & 0x80) {
    const lenLen = der[1] & 0x7f;
    offset = 2 + lenLen;
  }
  if (der[offset] !== 0x02) throw new Error('apple-jwt: r marker not INTEGER');
  const rLen = der[offset + 1];
  let r = der.slice(offset + 2, offset + 2 + rLen);
  offset = offset + 2 + rLen;
  if (der[offset] !== 0x02) throw new Error('apple-jwt: s marker not INTEGER');
  const sLen = der[offset + 1];
  let s = der.slice(offset + 2, offset + 2 + sLen);

  // Strip DER's sign-byte if present.
  if (r.length > keyByteLength && r[0] === 0x00) r = r.slice(r.length - keyByteLength);
  if (s.length > keyByteLength && s[0] === 0x00) s = s.slice(s.length - keyByteLength);
  // Left-pad short integers.
  if (r.length < keyByteLength) r = Buffer.concat([Buffer.alloc(keyByteLength - r.length, 0), r]);
  if (s.length < keyByteLength) s = Buffer.concat([Buffer.alloc(keyByteLength - s.length, 0), s]);
  return Buffer.concat([r, s]);
}

/**
 * Build the Apple "client secret" JWT.
 *
 * @param {Object}  opts
 * @param {string}  opts.teamId    Apple Developer team ID (issuer).
 * @param {string}  opts.clientId  The Service ID (audience subject).
 * @param {string}  opts.keyId     The 10-char Key ID from Apple.
 * @param {string|Buffer} opts.privateKey  PEM-encoded ES256 private key (.p8 contents).
 * @param {number} [opts.ttlSeconds=3600]
 * @param {Date}   [opts.now=new Date()]  override for tests
 * @returns {string} the signed JWT
 */
function buildAppleClientSecret({ teamId, clientId, keyId, privateKey, ttlSeconds = 3600, now = new Date() } = {}) {
  if (!teamId || !clientId || !keyId || !privateKey) {
    throw new Error('apple-jwt: teamId, clientId, keyId, privateKey are all required');
  }
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: teamId,
    iat,
    exp: iat + ttlSeconds,
    aud: 'https://appleid.apple.com',
    sub: clientId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const der = crypto.createSign('SHA256').update(signingInput).sign({
    key: privateKey,
    dsaEncoding: 'der',
  });
  // Some Node builds default to 'der' for EC keys; some default to
  // 'ieee-p1363'. We forced 'der' above so derToJose is always
  // correct. Convert to raw R||S for JOSE.
  const jose = derToJose(der, 32);
  return `${signingInput}.${b64url(jose)}`;
}

module.exports = { buildAppleClientSecret, derToJose };
