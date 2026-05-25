'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const google = require('../lib/providers/google');
const github = require('../lib/providers/github');
const microsoft = require('../lib/providers/microsoft');
const discord = require('../lib/providers/discord');
const apple = require('../lib/providers/apple');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function fetchRouter(routes) {
  return async (url, init) => {
    const handler = routes[url] || routes['*'];
    if (!handler) throw new Error(`no fetch handler for ${url}`);
    return handler(url, init);
  };
}

// --- google -----------------------------------------------------------

test('google: enabled requires clientId + clientSecret', () => {
  assert.equal(google.enabled({ clientId: 'a', clientSecret: 'b' }), true);
  assert.equal(google.enabled({ clientId: 'a' }), false);
  assert.equal(google.enabled({ clientSecret: 'b' }), false);
});

test('google: authorize URL carries PKCE challenge + state + scopes', () => {
  const cfg = google.readConfig({
    OAUTH_GOOGLE_CLIENT_ID: 'g-id',
    OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
  });
  const url = new URL(google.buildAuthorizeUrl({
    config: cfg,
    redirectUri: 'https://api.example.com/auth/google/callback',
    state: 'STATE',
    codeChallenge: 'CHAL',
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'g-id');
  assert.equal(url.searchParams.get('state'), 'STATE');
  assert.equal(url.searchParams.get('code_challenge'), 'CHAL');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
});

test('google: exchangeCode sends verifier and returns access_token; fetchProfile maps sub→providerUserId', async () => {
  const fetch = fetchRouter({
    'https://oauth2.googleapis.com/token': async (_url, init) => {
      const body = init.body;
      assert.match(body, /grant_type=authorization_code/);
      assert.match(body, /code=AUTHCODE/);
      assert.match(body, /code_verifier=V123/);
      return jsonResponse({ access_token: 'AT', token_type: 'Bearer' });
    },
    'https://openidconnect.googleapis.com/v1/userinfo': async (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer AT');
      return jsonResponse({
        sub: '123', email: 'd@e.com', email_verified: true,
        name: 'Dave Example', given_name: 'Dave', family_name: 'Example',
        picture: 'https://example/avatar.png',
      });
    },
  });
  const cfg = google.readConfig({
    OAUTH_GOOGLE_CLIENT_ID: 'g-id', OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
  });
  const tokens = await google.exchangeCode({
    config: cfg, code: 'AUTHCODE', redirectUri: 'cb', codeVerifier: 'V123', fetchImpl: fetch,
  });
  assert.equal(tokens.access_token, 'AT');
  const profile = await google.fetchProfile({ tokens, fetchImpl: fetch });
  assert.equal(profile.providerUserId, '123');
  assert.equal(profile.email, 'd@e.com');
  assert.equal(profile.firstName, 'Dave');
  assert.equal(profile.avatar, 'https://example/avatar.png');
});

// --- github -----------------------------------------------------------

test('github: fetchProfile falls back to /user/emails when primary email is private', async () => {
  const calls = [];
  const fetch = fetchRouter({
    'https://api.github.com/user': async (_url, init) => {
      calls.push('user');
      return jsonResponse({ id: 7, login: 'dave', name: 'Dave', email: null, avatar_url: 'https://gh/av.png' });
    },
    'https://api.github.com/user/emails': async (_url, init) => {
      calls.push('emails');
      return jsonResponse([
        { email: 'noreply@users.noreply.github.com', primary: false, verified: true },
        { email: 'private@example.com', primary: true, verified: true },
      ]);
    },
  });
  const profile = await github.fetchProfile({ tokens: { access_token: 'AT' }, fetchImpl: fetch });
  assert.deepEqual(calls, ['user', 'emails']);
  assert.equal(profile.providerUserId, '7');
  assert.equal(profile.email, 'private@example.com');
  assert.equal(profile.emailVerified, true);
});

test('github: fetchProfile uses public profile email when present (skips /user/emails)', async () => {
  const calls = [];
  const fetch = fetchRouter({
    'https://api.github.com/user': async () => {
      calls.push('user');
      return jsonResponse({ id: 8, login: 'a', email: 'a@b.com', avatar_url: null });
    },
    'https://api.github.com/user/emails': async () => {
      calls.push('emails');
      return jsonResponse([]);
    },
  });
  const profile = await github.fetchProfile({ tokens: { access_token: 'AT' }, fetchImpl: fetch });
  assert.deepEqual(calls, ['user']);
  assert.equal(profile.email, 'a@b.com');
});

test('github: authorize URL omits PKCE (provider does not support it)', () => {
  const cfg = github.readConfig({
    OAUTH_GITHUB_CLIENT_ID: 'gh', OAUTH_GITHUB_CLIENT_SECRET: 's',
  });
  const url = new URL(github.buildAuthorizeUrl({
    config: cfg, redirectUri: 'cb', state: 'S',
  }));
  assert.equal(github.supportsPkce, false);
  assert.equal(url.searchParams.get('code_challenge'), null);
});

// --- microsoft --------------------------------------------------------

test('microsoft: uses configured tenant (default "common")', () => {
  const cfg = microsoft.readConfig({
    OAUTH_MICROSOFT_CLIENT_ID: 'm', OAUTH_MICROSOFT_CLIENT_SECRET: 's',
  });
  const url = microsoft.buildAuthorizeUrl({ config: cfg, redirectUri: 'cb', state: 'S', codeChallenge: 'C' });
  assert.match(url, /\/common\/oauth2\/v2\.0\/authorize/);
  const cfg2 = microsoft.readConfig({
    OAUTH_MICROSOFT_CLIENT_ID: 'm', OAUTH_MICROSOFT_CLIENT_SECRET: 's', OAUTH_MICROSOFT_TENANT: 'org-123',
  });
  const url2 = microsoft.buildAuthorizeUrl({ config: cfg2, redirectUri: 'cb', state: 'S' });
  assert.match(url2, /\/org-123\/oauth2\/v2\.0\/authorize/);
});

// --- discord ----------------------------------------------------------

test('discord: fetchProfile maps fields and builds avatar URL', async () => {
  const fetch = fetchRouter({
    'https://discord.com/api/users/@me': async () =>
      jsonResponse({ id: '999', username: 'dave', global_name: 'Dave',
        email: 'd@x.com', verified: true, avatar: 'abc' }),
  });
  const profile = await discord.fetchProfile({ tokens: { access_token: 'AT' }, fetchImpl: fetch });
  assert.equal(profile.providerUserId, '999');
  assert.equal(profile.name, 'Dave');
  assert.equal(profile.emailVerified, true);
  assert.equal(profile.avatar, 'https://cdn.discordapp.com/avatars/999/abc.png');
});

// --- apple ------------------------------------------------------------

test('apple: enabled needs teamId + keyId + clientId + (privateKey OR keyPath)', () => {
  assert.equal(apple.enabled({}), false);
  assert.equal(apple.enabled({ clientId: 'a', teamId: 'b', keyId: 'c' }), false);
  assert.equal(
    apple.enabled({ clientId: 'a', teamId: 'b', keyId: 'c', privateKey: 'pem' }),
    true
  );
  assert.equal(
    apple.enabled({ clientId: 'a', teamId: 'b', keyId: 'c', keyPath: '/tmp/p8' }),
    true
  );
});

test('apple: fetchProfile decodes id_token and uses sub as providerUserId', async () => {
  const claims = { sub: 'APPLE.SUB.UID', email: 'rel@privaterelay.appleid.com', email_verified: 'true' };
  const idToken = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.fake-sig`;
  const profile = await apple.fetchProfile({ tokens: { id_token: idToken } });
  assert.equal(profile.providerUserId, 'APPLE.SUB.UID');
  assert.equal(profile.email, 'rel@privaterelay.appleid.com');
  assert.equal(profile.emailVerified, true); // coerced from "true"
});

test('apple: form_post `user` JSON is mined for firstName / lastName on first signin', async () => {
  const claims = { sub: 'APPLE.SUB', email: 'a@b.com', email_verified: true };
  const idToken = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.x`;
  const profile = await apple.fetchProfile({
    tokens: { id_token: idToken },
    extraParams: { user: JSON.stringify({ name: { firstName: 'Dave', lastName: 'Example' } }) },
  });
  assert.equal(profile.firstName, 'Dave');
  assert.equal(profile.lastName, 'Example');
  assert.equal(profile.name, 'Dave Example');
});

function b64url(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
