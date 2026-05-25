'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildAppleClientSecret, derToJose } = require('../lib/apple-jwt');

function genP256() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey,
  };
}

function b64urlDecodeToString(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (s.length % 4)) % 4), 'base64').toString('utf8');
}

function joseToDer(jose) {
  // Inverse of derToJose for the verification side.
  const r = jose.slice(0, 32);
  const s = jose.slice(32);
  function encInt(buf) {
    // Strip leading zero bytes; if MSB is set, prepend a 0x00 to
    // keep the integer positive in DER's signed encoding.
    let v = buf;
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.slice(i);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  }
  const body = Buffer.concat([encInt(r), encInt(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

test('buildAppleClientSecret signs a JWT that verifies under the matching public key', () => {
  const { privateKeyPem, publicKey } = genP256();
  const jwt = buildAppleClientSecret({
    teamId:   'TEAM1234',
    clientId: 'com.example.app',
    keyId:    'KEY1234567',
    privateKey: privateKeyPem,
  });
  const [headerB64, payloadB64, sigB64] = jwt.split('.');
  assert.ok(headerB64 && payloadB64 && sigB64);

  const header = JSON.parse(b64urlDecodeToString(headerB64));
  const payload = JSON.parse(b64urlDecodeToString(payloadB64));
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'KEY1234567');
  assert.equal(header.typ, 'JWT');
  assert.equal(payload.iss, 'TEAM1234');
  assert.equal(payload.sub, 'com.example.app');
  assert.equal(payload.aud, 'https://appleid.apple.com');
  assert.ok(payload.exp > payload.iat);

  // Verify signature: reconstruct DER, run through node crypto.
  const sigJose = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (sigB64.length % 4)) % 4), 'base64');
  const sigDer = joseToDer(sigJose);
  const verifier = crypto.createVerify('SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  assert.ok(verifier.verify(publicKey, sigDer), 'signature should verify');
});

test('buildAppleClientSecret requires teamId, clientId, keyId, privateKey', () => {
  const { privateKeyPem } = genP256();
  assert.throws(
    () => buildAppleClientSecret({ clientId: 'x', keyId: 'y', privateKey: privateKeyPem }),
    /required/
  );
  assert.throws(
    () => buildAppleClientSecret({ teamId: 'x', keyId: 'y', privateKey: privateKeyPem }),
    /required/
  );
  assert.throws(
    () => buildAppleClientSecret({ teamId: 'x', clientId: 'y', keyId: 'z' }),
    /required/
  );
});

test('derToJose pads short R / S values to 32 bytes each', () => {
  // r = 0x05 (1 byte), s = 0x06 (1 byte) — DER-encoded SEQUENCE.
  const der = Buffer.from([0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x06]);
  const jose = derToJose(der, 32);
  assert.equal(jose.length, 64);
  assert.equal(jose[31], 0x05);
  assert.equal(jose[63], 0x06);
});

test('derToJose strips the sign-pad byte from a 33-byte INTEGER', () => {
  // r = 33 bytes starting with 0x00 followed by 32 high-bit bytes.
  const r = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32, 0xff)]);
  const s = Buffer.alloc(32, 0x01);
  const seqBody = Buffer.concat([
    Buffer.from([0x02, r.length]), r,
    Buffer.from([0x02, s.length]), s,
  ]);
  const der = Buffer.concat([Buffer.from([0x30, seqBody.length]), seqBody]);
  const jose = derToJose(der, 32);
  assert.equal(jose.length, 64);
  assert.equal(jose[0], 0xff);
  assert.equal(jose[31], 0xff);
  assert.equal(jose[32], 0x01);
});
