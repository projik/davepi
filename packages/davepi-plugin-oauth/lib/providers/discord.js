'use strict';

/**
 * Discord OAuth2 adapter.
 *
 *   Authorize: https://discord.com/api/oauth2/authorize
 *   Token:     https://discord.com/api/oauth2/token
 *   Profile:   https://discord.com/api/users/@me
 *
 * Default scopes: `identify email`. PKCE supported.
 *
 * Discord returns `email_verified` on the profile — propagate it.
 * `email` may be null if the user denied the email scope on consent;
 * the consumer policy (refuse the login? accept emailless?) is the
 * upsert step's job.
 */

const DEFAULT_SCOPES = ['identify', 'email'];

function readConfig(env) {
  return {
    clientId:     env.OAUTH_DISCORD_CLIENT_ID || null,
    clientSecret: env.OAUTH_DISCORD_CLIENT_SECRET || null,
    scopes:       env.OAUTH_DISCORD_SCOPES ? env.OAUTH_DISCORD_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES,
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
    prompt: 'consent',
  });
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

async function exchangeCode({ config, code, redirectUri, codeVerifier, fetchImpl }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  const res = await fetchImpl('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    const err = new Error(`discord token exchange failed: ${json.error || res.status} ${json.error_description || ''}`.trim());
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function fetchProfile({ tokens, fetchImpl }) {
  const res = await fetchImpl('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  });
  const json = await res.json();
  if (!res.ok || !json.id) {
    const err = new Error(`discord profile fetch failed: ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  const avatar = json.avatar
    ? `https://cdn.discordapp.com/avatars/${json.id}/${json.avatar}.png`
    : null;
  return {
    providerUserId: String(json.id),
    email: json.email || null,
    emailVerified: Boolean(json.verified),
    name: json.global_name || json.username || null,
    firstName: null,
    lastName: null,
    avatar,
    raw: json,
  };
}

module.exports = {
  id: 'discord',
  displayName: 'Discord',
  supportsPkce: true,
  readConfig,
  enabled,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProfile,
};
