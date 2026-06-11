'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVerifyUrl,
  looksLikeEmail,
  sha256,
} = require('../lib/handlers');
const {
  StubValidationError,
  StubUnauthorizedError,
  StubForbiddenError,
  buildMountedHarness,
} = require('./helpers');

const EMAIL = 'alice@example.com';

function tokenFromMail(mail) {
  const match = mail.text.match(/token=([0-9a-f]{64})/);
  assert.ok(match, 'mail should contain a 64-char hex token: ' + mail.text);
  return match[1];
}

// ---- helpers ----

test('buildVerifyUrl: appends ?token=, &token=, or concatenates onto a trailing =', () => {
  assert.equal(buildVerifyUrl('https://a/verify', 'T'), 'https://a/verify?token=T');
  assert.equal(buildVerifyUrl('https://a/verify?x=1', 'T'), 'https://a/verify?x=1&token=T');
  assert.equal(buildVerifyUrl('https://a/verify?token=', 'T'), 'https://a/verify?token=T');
});

test('looksLikeEmail: accepts plausible addresses, rejects junk', () => {
  assert.equal(looksLikeEmail('a@b.co'), true);
  assert.equal(looksLikeEmail('first.last+tag@sub.domain.org'), true);
  assert.equal(looksLikeEmail('not-an-email'), false);
  assert.equal(looksLikeEmail('a b@c.d'), false);
  assert.equal(looksLikeEmail(''), false);
  assert.equal(looksLikeEmail(null), false);
  assert.equal(looksLikeEmail('a@b.' + 'c'.repeat(320)), false);
});

// ---- request ----

test('request: invalid email yields ValidationError', async () => {
  const h = await buildMountedHarness();
  const { captured } = await h.dispatch('/auth/magic-link/request', {
    body: { email: 'nope' },
  });
  assert.ok(captured.err instanceof StubValidationError);
});

test('request: known email gets 204 + a mail whose token hash is stored (never plaintext)', async () => {
  const h = await buildMountedHarness();
  await h.User.create({ email: EMAIL, first_name: 'Alice' });

  const { res, captured } = await h.dispatch('/auth/magic-link/request', {
    body: { email: EMAIL },
  });
  assert.equal(captured.err, null);
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);

  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0].to, EMAIL);
  assert.match(h.mails[0].subject, /TestApp/);
  const raw = tokenFromMail(h.mails[0]);

  assert.equal(h.MagicLinkToken.rows.length, 1);
  const row = h.MagicLinkToken.rows[0];
  assert.equal(row.tokenHash, sha256(raw));
  assert.equal(row.purpose, 'login');
  assert.ok(row.expiresAt > new Date());
  assert.ok(!JSON.stringify(row).includes(raw), 'raw token must not be persisted');
});

test('request: new email creates a user with default roles and a hashed random password', async () => {
  const h = await buildMountedHarness();
  const { res } = await h.dispatch('/auth/magic-link/request', {
    body: { email: 'New.Person@Example.COM', name: 'New Person Jr' },
  });
  assert.equal(res.statusCode, 204);
  const user = h.User.byEmail.get('new.person@example.com');
  assert.ok(user, 'user should be created with lowercased email');
  assert.equal(user.first_name, 'New');
  assert.equal(user.last_name, 'Person Jr');
  assert.equal(user.password, 'hashed-password');
  assert.deepEqual(user.roles, ['user']);
});

test('request: MAGIC_LINK_DEFAULT_ROLES applies to created users', async () => {
  const h = await buildMountedHarness({
    env: { MAGIC_LINK_DEFAULT_ROLES: 'member, viewer' },
  });
  await h.dispatch('/auth/magic-link/request', { body: { email: EMAIL } });
  assert.deepEqual(h.User.byEmail.get(EMAIL).roles, ['member', 'viewer']);
});

test('request: allowSignup=false still returns 204 for unknown emails but sends nothing (no enumeration)', async () => {
  const h = await buildMountedHarness({
    env: { MAGIC_LINK_ALLOW_SIGNUP: 'false' },
  });
  const { res, captured } = await h.dispatch('/auth/magic-link/request', {
    body: { email: 'stranger@example.com' },
  });
  assert.equal(captured.err, null);
  assert.equal(res.statusCode, 204);
  assert.equal(h.mails.length, 0);
  assert.equal(h.User.byEmail.size, 0);
  assert.equal(h.MagicLinkToken.rows.length, 0);
});

test('request: E11000 create race re-queries instead of failing', async () => {
  const h = await buildMountedHarness();
  const dup = new Error('E11000 duplicate key');
  dup.code = 11000;
  h.User.failNextCreateWith = dup;
  // Simulate the concurrent winner: the user exists by the time we re-query.
  const winner = { _id: 'u99', email: EMAIL, first_name: 'Race', roles: ['user'] };
  h.User.byEmail.set(EMAIL, winner);
  h.User.byId.set('u99', winner);
  // findOne is consulted before create, so make the first lookup miss.
  let firstLookup = true;
  const origFindOne = h.User.findOne.bind(h.User);
  h.User.findOne = async (q) => {
    if (firstLookup) { firstLookup = false; return null; }
    return origFindOne(q);
  };

  const { res, captured } = await h.dispatch('/auth/magic-link/request', {
    body: { email: EMAIL },
  });
  assert.equal(captured.err, null);
  assert.equal(res.statusCode, 204);
  assert.equal(h.MagicLinkToken.rows[0].userId, 'u99');
});

test('request: internal DB error is swallowed and still returns 204 (enumeration-safe)', async () => {
  const h = await buildMountedHarness();
  await h.User.create({ email: EMAIL, first_name: 'Alice' });
  h.MagicLinkToken.failNextCreateWith = new Error('DB unavailable');

  const { res, captured } = await h.dispatch('/auth/magic-link/request', {
    body: { email: EMAIL },
  });
  assert.equal(captured.err, null);
  assert.equal(res.statusCode, 204);
  assert.equal(h.mails.length, 0);
});

test('request: mail delivery error is swallowed and still returns 204 (enumeration-safe)', async () => {
  const h = await buildMountedHarness();
  await h.User.create({ email: EMAIL, first_name: 'Alice' });
  h.failNextSendMailWith = new Error('SMTP unavailable');

  const { res, captured } = await h.dispatch('/auth/magic-link/request', {
    body: { email: EMAIL },
  });
  assert.equal(captured.err, null);
  assert.equal(res.statusCode, 204);
});

// ---- verify ----

test('verify: missing token yields ValidationError', async () => {
  const h = await buildMountedHarness();
  const { captured } = await h.dispatch('/auth/magic-link/verify', { body: {} });
  assert.ok(captured.err instanceof StubValidationError);
});

test('verify: unknown token yields UnauthorizedError', async () => {
  const h = await buildMountedHarness();
  const { captured } = await h.dispatch('/auth/magic-link/verify', {
    body: { token: 'f'.repeat(64) },
  });
  assert.ok(captured.err instanceof StubUnauthorizedError);
});

test('verify: happy path mints a session and the link is single-use', async () => {
  const h = await buildMountedHarness();
  await h.dispatch('/auth/magic-link/request', { body: { email: EMAIL } });
  const raw = tokenFromMail(h.mails[0]);

  const first = await h.dispatch('/auth/magic-link/verify', {
    body: { token: raw },
  });
  assert.equal(first.captured.err, null);
  assert.equal(first.res.statusCode, 200);
  assert.match(first.res.body.accessToken, /^AT\./);
  assert.match(first.res.body.refreshToken, /^RT\./);
  assert.equal(first.res.body.user.email, EMAIL);
  assert.equal(first.res.body.purpose, 'login');
  assert.equal(first.res.body.meta, null);

  const replay = await h.dispatch('/auth/magic-link/verify', {
    body: { token: raw },
  });
  assert.ok(replay.captured.err instanceof StubUnauthorizedError);
});

test('verify: expired token is rejected at read time', async () => {
  const h = await buildMountedHarness();
  await h.dispatch('/auth/magic-link/request', { body: { email: EMAIL } });
  const raw = tokenFromMail(h.mails[0]);
  h.MagicLinkToken.rows[0].expiresAt = new Date(Date.now() - 1000);

  const { captured } = await h.dispatch('/auth/magic-link/verify', {
    body: { token: raw },
  });
  assert.ok(captured.err instanceof StubUnauthorizedError);
});

test('verify: deleted account is rejected', async () => {
  const h = await buildMountedHarness();
  await h.dispatch('/auth/magic-link/request', { body: { email: EMAIL } });
  const raw = tokenFromMail(h.mails[0]);
  h.User.byId.clear();

  const { captured } = await h.dispatch('/auth/magic-link/verify', {
    body: { token: raw },
  });
  assert.ok(captured.err instanceof StubUnauthorizedError);
});

// ---- invite ----

test('verify: falsy meta values (false, 0, "") are preserved and not coerced to null', async () => {
  const h = await buildMountedHarness({
    authoriseInvite: async (req, { email, meta }) => ({ userId: req.user.user_id }),
  });
  const inviter = await h.User.create({ email: 'bob@example.com' });

  for (const falsyMeta of [false, 0, '']) {
    h.mails.length = 0;
    h.MagicLinkToken.rows.length = 0;
    await h.dispatch('/auth/magic-link/invite', {
      body: { email: EMAIL, meta: falsyMeta },
      user: { user_id: inviter._id },
    });
    const raw = tokenFromMail(h.mails[0]);
    const { res } = await h.dispatch('/auth/magic-link/verify', { body: { token: raw } });
    assert.strictEqual(res.body.meta, falsyMeta, `meta ${JSON.stringify(falsyMeta)} should round-trip unchanged`);
  }
});

test('invite: meta without a registered authoriser is refused', async () => {
  const h = await buildMountedHarness();
  const { captured } = await h.dispatch('/auth/magic-link/invite', {
    body: { email: EMAIL, meta: { householdId: 'h1' } },
    user: { user_id: 'u1' },
  });
  assert.ok(captured.err instanceof StubForbiddenError);
  assert.equal(h.MagicLinkToken.rows.length, 0);
});

test('invite: without meta, invitee gets their own find-or-create account', async () => {
  const h = await buildMountedHarness();
  const { res, captured } = await h.dispatch('/auth/magic-link/invite', {
    body: { email: EMAIL, name: 'Alice', note: 'come join' },
    user: { user_id: 'u1', first_name: 'Bob', last_name: 'Inviter' },
  });
  assert.equal(captured.err, null);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(h.mails.length, 1);
  assert.match(h.mails[0].text, /come join/);
  assert.match(h.mails[0].text, /by Bob Inviter/);
  const invitee = h.User.byEmail.get(EMAIL);
  assert.ok(invitee);
  assert.equal(h.MagicLinkToken.rows[0].userId, String(invitee._id));
  assert.equal(h.MagicLinkToken.rows[0].purpose, 'invite');
});

test('invite: authoriser can bind the link to a specific account, and meta round-trips through verify', async () => {
  const seen = [];
  const h = await buildMountedHarness({
    authoriseInvite: async (req, { email, meta }) => {
      seen.push({ caller: req.user.user_id, email, meta });
      return { userId: req.user.user_id };
    },
  });
  const inviter = await h.User.create({ email: 'bob@example.com', first_name: 'Bob' });

  const { res } = await h.dispatch('/auth/magic-link/invite', {
    body: { email: EMAIL, meta: { householdId: 'h1', partnerId: 'p2' } },
    user: { user_id: inviter._id },
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(seen, [
    { caller: inviter._id, email: EMAIL, meta: { householdId: 'h1', partnerId: 'p2' } },
  ]);
  // No account is created for the invitee — they log into the inviter's.
  assert.equal(h.User.byEmail.has(EMAIL), false);

  const raw = tokenFromMail(h.mails[0]);
  const verify = await h.dispatch('/auth/magic-link/verify', { body: { token: raw } });
  assert.equal(verify.res.statusCode, 200);
  assert.equal(verify.res.body.user._id, inviter._id);
  assert.equal(verify.res.body.purpose, 'invite');
  assert.deepEqual(verify.res.body.meta, { householdId: 'h1', partnerId: 'p2' });
});

test('invite: an authoriser throw propagates and nothing is minted or sent', async () => {
  const h = await buildMountedHarness({
    authoriseInvite: async () => {
      throw new StubForbiddenError('household not found for this account');
    },
  });
  const { captured } = await h.dispatch('/auth/magic-link/invite', {
    body: { email: EMAIL, meta: { householdId: 'not-yours' } },
    user: { user_id: 'u1' },
  });
  assert.ok(captured.err instanceof StubForbiddenError);
  assert.equal(h.MagicLinkToken.rows.length, 0);
  assert.equal(h.mails.length, 0);
});

test('invite: signup disabled + unknown invitee + no bound account is refused', async () => {
  const h = await buildMountedHarness({
    env: { MAGIC_LINK_ALLOW_SIGNUP: 'false' },
  });
  const { captured } = await h.dispatch('/auth/magic-link/invite', {
    body: { email: 'stranger@example.com' },
    user: { user_id: 'u1' },
  });
  assert.ok(captured.err instanceof StubForbiddenError);
});

test('invite: invalid email yields ValidationError', async () => {
  const h = await buildMountedHarness();
  const { captured } = await h.dispatch('/auth/magic-link/invite', {
    body: { email: 'junk' },
    user: { user_id: 'u1' },
  });
  assert.ok(captured.err instanceof StubValidationError);
});
