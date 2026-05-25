'use strict';

/**
 * Google OAuth2 / OIDC adapter.
 *
 *   Authorize: https://accounts.google.com/o/oauth2/v2/auth
 *   Token:     https://oauth2.googleapis.com/token
 *   UserInfo:  https://openidconnect.googleapis.com/v1/userinfo
 *
 * Default scopes: `openid email profile`. PKCE supported and used.
 * Profile shape: `{ sub, email, email_verified, name, picture }`.
 */

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

function readConfig(env) {
  return {
    clientId:     env.OAUTH_GOOGLE_CLIENT_ID || null,
    clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET || null,
    scopes:       env.OAUTH_GOOGLE_SCOPES ? env.OAUTH_GOOGLE_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES,
  };
}

function enabled(config) {
  return Boolean(config.clientId && config.clientSecret);
}

function buildAuthorizeUrl({ config, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(' '),
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode({ config, code, redirectUri, codeVerifier, fetchImpl }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    const err = new Error(`google token exchange failed: ${json.error || res.status} ${json.error_description || ''}`.trim());
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function fetchProfile({ tokens, fetchImpl }) {
  const res = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  });
  const json = await res.json();
  if (!res.ok || !json.sub) {
    const err = new Error(`google profile fetch failed: ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return {
    providerUserId: String(json.sub),
    email: json.email || null,
    emailVerified: Boolean(json.email_verified),
    name: json.name || null,
    firstName: json.given_name || null,
    lastName: json.family_name || null,
    avatar: json.picture || null,
    raw: json,
  };
}

module.exports = {
  id: 'google',
  displayName: 'Google',
  supportsPkce: true,
  readConfig,
  enabled,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProfile,
};
