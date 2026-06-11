'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlugin } = require('../index');
const { stubErrors, silentLog, buildHarness, buildMountedHarness } = require('./helpers');

test('plugin exports the standard { name, setup } contract', () => {
  const plugin = require('../index');
  assert.equal(plugin.name, 'magic-link');
  assert.equal(typeof plugin.setup, 'function');
  assert.equal(typeof plugin.createPlugin, 'function');
});

test('setup: dormant when MAGIC_LINK_URL is unset (warn, no routes, no throw)', async () => {
  const warns = [];
  const log = {
    ...silentLog(),
    warn: (ctx, msg) => warns.push(msg),
  };
  const plugin = createPlugin({ env: {}, errors: stubErrors });
  const mounted = [];
  await plugin.setup({
    app: { post: (p) => mounted.push(p) },
    log,
  });
  assert.equal(plugin.isEnabled(), false);
  assert.equal(mounted.length, 0);
  assert.match(warns[0], /MAGIC_LINK_URL not set/);
});

test('issueMagicLink throws a clear error while dormant', async () => {
  const plugin = createPlugin({ env: {}, errors: stubErrors });
  await assert.rejects(
    () => plugin.issueMagicLink({ email: 'a@b.co' }),
    /dormant/
  );
});

test('setup: mounts request/verify/invite under MAGIC_LINK_PATH', async () => {
  const h = await buildMountedHarness({
    env: { MAGIC_LINK_PATH: '/auth/links' },
  });
  assert.equal(h.plugin.isEnabled(), true);
  assert.deepEqual(
    [...h.routes.keys()].sort(),
    ['/auth/links/invite', '/auth/links/request', '/auth/links/verify']
  );
});

test('setup: APP_NAME env wins over the loader-provided appName', async () => {
  const h = await buildMountedHarness();
  assert.equal(h.plugin._state.appName, 'TestApp');

  const fallback = createPlugin({
    env: { MAGIC_LINK_URL: 'https://a/verify' },
    errors: stubErrors,
    User: {},
    MagicLinkToken: {},
    issueTokenPair: async () => ({}),
    sendMail: async () => {},
    bcrypt: { hash: async () => 'x' },
    verifyAuth: () => (req, res, next) => next(),
    authLimiter: (req, res, next) => next(),
  });
  await fallback.setup({ appName: 'LoaderApp', log: silentLog() });
  assert.equal(fallback._state.appName, 'LoaderApp');
});

test('setup: without an Express app the plugin still enables for programmatic use', async () => {
  const h = buildHarness();
  await h.plugin.setup({ log: silentLog() });
  assert.equal(h.plugin.isEnabled(), true);

  const raw = await h.plugin.issueMagicLink({
    email: 'a@b.co',
    userId: 'u1',
    purpose: 'invite',
    meta: { campaign: 'beta' },
  });
  assert.match(raw, /^[0-9a-f]{64}$/);
  assert.equal(h.MagicLinkToken.rows.length, 1);
  assert.equal(h.MagicLinkToken.rows[0].userId, 'u1');
  assert.deepEqual(h.MagicLinkToken.rows[0].meta, { campaign: 'beta' });
  assert.notEqual(h.MagicLinkToken.rows[0].tokenHash, raw);
});

test('registerInviteAuthoriser validates its argument and wires the handler', async () => {
  const h = buildHarness();
  assert.throws(() => h.plugin.registerInviteAuthoriser('nope'), /expects a function/);
  const fn = async () => {};
  h.plugin.registerInviteAuthoriser(fn);
  assert.equal(h.plugin._state.authoriseInvite, fn);
});

test('config: TTL is clamped to a sane range with a 30-minute default', () => {
  const cases = [
    [undefined, 30],
    ['', 30],
    ['abc', 30],
    ['0', 30],
    ['-5', 30],
    ['100000', 30],
    ['120', 120],
  ];
  for (const [raw, expected] of cases) {
    const plugin = createPlugin({
      env: { MAGIC_LINK_URL: 'https://a/v', MAGIC_LINK_TTL_MINUTES: raw },
    });
    assert.equal(plugin._state.config.ttlMinutes, expected, `raw=${raw}`);
  }
});

test('config: allowSignup defaults true and only an explicit "false" disables it', () => {
  const mk = (v) =>
    createPlugin({ env: { MAGIC_LINK_URL: 'https://a/v', MAGIC_LINK_ALLOW_SIGNUP: v } })
      ._state.config.allowSignup;
  assert.equal(mk(undefined), true);
  assert.equal(mk('true'), true);
  assert.equal(mk('false'), false);
});

test('token expiry honours the configured TTL', async () => {
  const h = buildHarness({ env: { MAGIC_LINK_TTL_MINUTES: '5' } });
  await h.plugin.setup({ log: silentLog() });
  const before = Date.now();
  await h.plugin.issueMagicLink({ email: 'a@b.co', userId: 'u1' });
  const expiresAt = h.MagicLinkToken.rows[0].expiresAt.getTime();
  assert.ok(expiresAt >= before + 5 * 60_000 - 1000);
  assert.ok(expiresAt <= Date.now() + 5 * 60_000 + 1000);
});
