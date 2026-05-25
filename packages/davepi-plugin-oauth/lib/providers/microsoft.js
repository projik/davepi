'use strict';

/**
 * Microsoft (Azure AD / Entra) OAuth2 / OIDC adapter.
 *
 * Uses the `common` tenant by default so personal Microsoft accounts
 * and work/school accounts both authenticate; set OAUTH_MICROSOFT_TENANT
 * to a specific tenant id (or `organizations`, `consumers`) to scope.
 *
 *   Authorize: https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
 *   Token:     https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   UserInfo:  https://graph.microsoft.com/oidc/userinfo
 *
 * Default scopes: `openid email profile`. PKCE supported and used.
 */

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

function readConfig(env) {
  return {
    clientId:     env.OAUTH_MICROSOFT_CLIENT_ID || null,
    clientSecret: env.OAUTH_MICROSOFT_CLIENT_SECRET || null,
    tenant:       env.OAUTH_MICROSOFT_TENANT || 'common',
    scopes:       env.OAUTH_MICROSOFT_SCOPES ? env.OAUTH_MICROSOFT_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES,
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
    response_mode: 'query',
  });
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function exchangeCode({ config, code, redirectUri, codeVerifier, fetchImpl }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    scope: config.scopes.join(' '),
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  const url = `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    const err = new Error(`microsoft token exchange failed: ${json.error || res.status} ${json.error_description || ''}`.trim());
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function fetchProfile({ tokens, fetchImpl }) {
  const res = await fetchImpl('https://graph.microsoft.com/oidc/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  });
  const json = await res.json();
  if (!res.ok || !json.sub) {
    const err = new Error(`microsoft profile fetch failed: ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return {
    providerUserId: String(json.sub),
    email: json.email || null,
    emailVerified: true, // Microsoft only emits emails it has validated.
    name: json.name || null,
    firstName: json.given_name || null,
    lastName: json.family_name || null,
    avatar: json.picture || null,
    raw: json,
  };
}

module.exports = {
  id: 'microsoft',
  displayName: 'Microsoft',
  supportsPkce: true,
  readConfig,
  enabled,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProfile,
};
