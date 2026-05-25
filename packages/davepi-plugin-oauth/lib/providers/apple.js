'use strict';

/**
 * Sign in with Apple adapter.
 *
 *   Authorize: https://appleid.apple.com/auth/authorize
 *   Token:     https://appleid.apple.com/auth/token
 *
 * Apple is unusual in three ways:
 *
 *   1. The client secret is itself a JWT signed with an ES256 key
 *      (the .p8 file from the Apple Developer console). See
 *      ../apple-jwt.js — generated per request, ~1h lifetime.
 *   2. There is no separate UserInfo endpoint. The token response
 *      includes an `id_token` (JWT) whose claims are the profile.
 *      We decode (no signature verification — we just got it over
 *      TLS from Apple itself a millisecond ago) and pull `sub`,
 *      `email`, `email_verified`.
 *   3. `email` may only appear on the *first* sign-in (Apple's
 *      privacy posture), and may be a relay address
 *      (...@privaterelay.appleid.com). The `sub` claim is the
 *      stable id and what we persist as `providerUserId`.
 *
 * Apple requires `response_mode=form_post` when `scope` is non-empty
 * (`name` / `email`). For OIDC-only sign-in (`scope=openid`) Apple
 * tolerates `response_mode=query`; we use `form_post` whenever the
 * scope list contains anything beyond `openid` so the consent screen
 * actually surfaces the requested fields.
 */

const { buildAppleClientSecret } = require('../apple-jwt');

const DEFAULT_SCOPES = ['openid', 'email', 'name'];

function readConfig(env) {
  return {
    clientId:     env.OAUTH_APPLE_CLIENT_ID || null,
    teamId:       env.OAUTH_APPLE_TEAM_ID || null,
    keyId:        env.OAUTH_APPLE_KEY_ID || null,
    keyPath:      env.OAUTH_APPLE_KEY_PATH || null,
    privateKey:   env.OAUTH_APPLE_PRIVATE_KEY || null,
    scopes:       env.OAUTH_APPLE_SCOPES ? env.OAUTH_APPLE_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES,
  };
}

function enabled(config) {
  if (!config.clientId || !config.teamId || !config.keyId) return false;
  return Boolean(config.privateKey || config.keyPath);
}

function buildAuthorizeUrl({ config, redirectUri, state, codeChallenge }) {
  const scopes = config.scopes.join(' ');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
  });
  // form_post is required by Apple whenever scope requests `name` or
  // `email` (anything that surfaces user data on the consent screen).
  // For pure `openid` we'd use query; we always default to scope=email/name
  // so we always set form_post here.
  const scopeList = (config.scopes || []).map((s) => s.toLowerCase());
  const needsFormPost = scopeList.some((s) => s !== 'openid');
  if (needsFormPost) params.set('response_mode', 'form_post');
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
}

function resolvePrivateKey(config, fs = require('fs')) {
  if (config.privateKey) return config.privateKey;
  if (config.keyPath) return fs.readFileSync(config.keyPath, 'utf8');
  throw new Error('apple: no private key configured');
}

async function exchangeCode({ config, code, redirectUri, codeVerifier, fetchImpl, now, fs }) {
  const privateKey = resolvePrivateKey(config, fs);
  const clientSecret = buildAppleClientSecret({
    teamId: config.teamId,
    clientId: config.clientId,
    keyId: config.keyId,
    privateKey,
    now,
  });
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  const res = await fetchImpl('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.id_token) {
    const err = new Error(`apple token exchange failed: ${json.error || res.status} ${json.error_description || ''}`.trim());
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function decodeIdToken(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('apple: id_token not a JWT');
  const payload = Buffer.from(
    parts[1].replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (parts[1].length % 4)) % 4),
    'base64'
  ).toString('utf8');
  return JSON.parse(payload);
}

async function fetchProfile({ tokens, extraParams /* form_post body */ }) {
  // Apple's profile lives in the id_token. The `name` (given/family)
  // is delivered only on the first sign-in, in the form_post body,
  // not in the id_token — Apple's "we forget on subsequent logins"
  // privacy posture. The plugin's callback handler stuffs the parsed
  // form_post body in `extraParams` so we can pick it up here.
  const claims = decodeIdToken(tokens.id_token);
  if (!claims.sub) {
    const err = new Error('apple: id_token missing sub claim');
    err.body = claims;
    throw err;
  }
  let firstName = null;
  let lastName = null;
  let displayName = null;
  if (extraParams && typeof extraParams.user === 'string') {
    try {
      const userObj = JSON.parse(extraParams.user);
      firstName = (userObj.name && userObj.name.firstName) || null;
      lastName  = (userObj.name && userObj.name.lastName) || null;
      if (firstName || lastName) {
        displayName = [firstName, lastName].filter(Boolean).join(' ');
      }
    } catch (_) { /* ignore */ }
  }
  // Apple's email_verified is sometimes a string ("true"/"false");
  // coerce.
  const emailVerified = claims.email_verified === true ||
    claims.email_verified === 'true';
  return {
    providerUserId: String(claims.sub),
    email: claims.email || null,
    emailVerified,
    name: displayName,
    firstName,
    lastName,
    avatar: null,
    raw: claims,
  };
}

module.exports = {
  id: 'apple',
  displayName: 'Apple',
  supportsPkce: true,
  readConfig,
  enabled,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProfile,
  decodeIdToken,
};
