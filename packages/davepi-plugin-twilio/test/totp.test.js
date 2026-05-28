'use strict';

/**
 * TOTP enroll / verify / challenge tests. We stub otplib's
 * authenticator with a tiny `{ generateSecret, keyuri, verify }` so
 * the package is testable without otplib installed; we round-trip
 * encrypt/decrypt on the AES-256-GCM helper to lock in the cipher
 * contract; and we drive the handlers via stub User model + stub
 * issueTokenPair.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { encrypt, decrypt } = require('../index');
const { buildTotpHandlers, generateBackupCode, sha256 } = require('../lib/totp');

class StubValidationError   extends Error { constructor(m){super(m);this.status=400;} }
class StubUnauthorizedError extends Error { constructor(m){super(m);this.status=401;} }
class StubNotFoundError     extends Error { constructor(m){super(m);this.status=404;} }
const stubErrors = {
  ValidationError: StubValidationError,
  UnauthorizedError: StubUnauthorizedError,
  NotFoundError: StubNotFoundError,
};

function memUserModel(seed = {}) {
  const u = { _id: 'u1', email: 'x@y.com', ...seed };
  return {
    user: u,
    async findById(id) { return String(id) === String(u._id) ? u : null; },
    async findByIdAndUpdate(id, update) {
      if (String(id) !== String(u._id)) return null;
      Object.assign(u, update.$set || {});
      if (update.$unset) for (const k of Object.keys(update.$unset)) delete u[k];
      return u;
    },
    async findOne(q) {
      if (q.phone && u.phone === q.phone) return u;
      return null;
    },
  };
}

function fakeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function captureNext() {
  const c = { err: null };
  return { next: (e) => { c.err = e; }, captured: c };
}

const TOKEN_KEY = 'unit-totp-key';

function totpStub() {
  return {
    generateSecret: () => 'JBSWY3DPEHPK3PXP',
    keyuri: (label, issuer, secret) => `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}`,
    verifyArgsSeen: [],
    verify({ token, secret }) {
      this.verifyArgsSeen.push({ token, secret });
      return token === '123456' && secret === 'JBSWY3DPEHPK3PXP';
    },
  };
}

function buildHarness({ seedUser, verifyTotpForUser } = {}) {
  const User = memUserModel(seedUser);
  const totp = totpStub();
  const issueTokenPair = async (user) => ({
    accessToken: 'AT.' + user._id,
    refreshToken: 'RT.' + user._id,
  });
  const state = {
    errors: stubErrors,
    User,
    totp,
    issueTokenPair,
    appName: 'TestApp',
    config: { tokenKey: TOKEN_KEY },
  };
  const verifyForUser = verifyTotpForUser || (async (uid, code) => {
    const user = await User.findById(uid);
    if (!user || !user.totpSecretEnc) return false;
    const secret = decrypt(user.totpSecretEnc, TOKEN_KEY);
    if (totp.verify({ token: code, secret })) return true;
    const hashes = Array.isArray(user.backupCodeHashes) ? user.backupCodeHashes : [];
    const h = sha256(code);
    const idx = hashes.indexOf(h);
    if (idx === -1) return false;
    user.backupCodeHashes = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
    return true;
  });
  const handlers = buildTotpHandlers({ config: state.config, state, verifyTotpForUser: verifyForUser });
  return { handlers, User, totp, state, verifyForUser };
}

// ---- encrypt/decrypt round-trip ----

test('encrypt/decrypt: round-trips the plaintext through AES-256-GCM', () => {
  const wire = encrypt('JBSWY3DPEHPK3PXP', TOKEN_KEY);
  assert.match(wire, /^[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/);
  assert.equal(decrypt(wire, TOKEN_KEY), 'JBSWY3DPEHPK3PXP');
});

test('decrypt fails on a tampered ciphertext (auth tag mismatch)', () => {
  const wire = encrypt('secret', TOKEN_KEY);
  const [iv, tag, ct] = wire.split('.');
  // Flip a byte in the ciphertext.
  const tamperedCt = (parseInt(ct.slice(0, 2), 16) ^ 0xFF).toString(16).padStart(2, '0') + ct.slice(2);
  assert.throws(() => decrypt([iv, tag, tamperedCt].join('.'), TOKEN_KEY));
});

test('encrypt throws when TOKEN_KEY is missing', () => {
  assert.throws(() => encrypt('x', undefined), /TOKEN_KEY/);
});

test('generateBackupCode returns 12-char codes from the base32-ish alphabet', () => {
  for (let i = 0; i < 20; i++) {
    const c = generateBackupCode();
    assert.equal(c.length, 12);
    assert.match(c, /^[A-Z2-9]+$/);
  }
});

// ---- enroll ----

test('enroll: stores totpPendingEnc + backupCodeHashes; returns plaintext codes once', async () => {
  const h = buildHarness();
  const req = { user: { user_id: 'u1', email: 'x@y.com' }, body: {} };
  const res = fakeRes();
  const { next, captured } = captureNext();
  await h.handlers.enroll(req, res, next);

  assert.equal(captured.err, null, 'should not error');
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body.secret, 'string');
  assert.match(res.body.otpauthUrl, /^otpauth:\/\//);
  assert.equal(res.body.backupCodes.length, 8);
  res.body.backupCodes.forEach((c) => assert.equal(c.length, 12));

  // User has pending secret encrypted; round-trips back via decrypt.
  assert.ok(h.User.user.totpPendingEnc);
  assert.equal(decrypt(h.User.user.totpPendingEnc, TOKEN_KEY), 'JBSWY3DPEHPK3PXP');
  assert.equal(h.User.user.twofaEnabled, undefined); // not yet
  // Hashes stored, not plaintext.
  assert.equal(h.User.user.backupCodeHashes.length, 8);
  h.User.user.backupCodeHashes.forEach((hash) => assert.equal(hash.length, 64));
});

test('enroll: unauthenticated → UnauthorizedError', async () => {
  const h = buildHarness();
  const { next, captured } = captureNext();
  await h.handlers.enroll({ user: null, body: {} }, fakeRes(), next);
  assert.ok(captured.err instanceof StubUnauthorizedError);
});

// ---- verify ----

test('verify: correct code moves pending → confirmed and flips twofaEnabled', async () => {
  const h = buildHarness();
  // Enroll first.
  await h.handlers.enroll({ user: { user_id: 'u1' }, body: {} }, fakeRes(), () => {});
  assert.equal(h.User.user.twofaEnabled, undefined);

  const res = fakeRes();
  const { next, captured } = captureNext();
  await h.handlers.verify({ user: { user_id: 'u1' }, body: { code: '123456' } }, res, next);
  assert.equal(captured.err, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(h.User.user.twofaEnabled, true);
  assert.ok(h.User.user.totpSecretEnc);
  assert.equal(h.User.user.totpPendingEnc, undefined);
});

test('verify: wrong code → UnauthorizedError; pending stays put', async () => {
  const h = buildHarness();
  await h.handlers.enroll({ user: { user_id: 'u1' }, body: {} }, fakeRes(), () => {});
  const { next, captured } = captureNext();
  await h.handlers.verify({ user: { user_id: 'u1' }, body: { code: '000000' } }, fakeRes(), next);
  assert.ok(captured.err instanceof StubUnauthorizedError);
  assert.equal(h.User.user.twofaEnabled, undefined);
  assert.ok(h.User.user.totpPendingEnc);
});

// ---- challenge ----

test('challenge: valid TOTP issues a JWT pair', async () => {
  const h = buildHarness({
    seedUser: {
      twofaEnabled: true,
      totpSecretEnc: encrypt('JBSWY3DPEHPK3PXP', TOKEN_KEY),
    },
  });
  const res = fakeRes();
  const { next, captured } = captureNext();
  await h.handlers.challenge({ body: { userId: 'u1', code: '123456' } }, res, next);
  assert.equal(captured.err, null);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.accessToken, /^AT\./);
});

test('challenge: valid backup code issues a JWT and removes the used hash', async () => {
  const backup = 'AAAA22BBBB33';
  const h = buildHarness({
    seedUser: {
      twofaEnabled: true,
      totpSecretEnc: encrypt('SOMEOTHER', TOKEN_KEY),
      backupCodeHashes: [sha256(backup), sha256('OTHER1OTHER1')],
    },
  });
  const res = fakeRes();
  const { next, captured } = captureNext();
  await h.handlers.challenge({ body: { userId: 'u1', code: backup } }, res, next);
  assert.equal(captured.err, null);
  assert.equal(res.statusCode, 200);
  assert.equal(h.User.user.backupCodeHashes.length, 1);
  assert.equal(h.User.user.backupCodeHashes[0], sha256('OTHER1OTHER1'));
});

test('challenge: 2FA not enabled → UnauthorizedError', async () => {
  const h = buildHarness({ seedUser: { /* no twofaEnabled */ } });
  const { next, captured } = captureNext();
  await h.handlers.challenge({ body: { userId: 'u1', code: '123456' } }, fakeRes(), next);
  assert.ok(captured.err instanceof StubUnauthorizedError);
});
