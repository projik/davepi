'use strict';

/**
 * GitHub OAuth2 adapter.
 *
 *   Authorize: https://github.com/login/oauth/authorize
 *   Token:     https://github.com/login/oauth/access_token
 *   Profile:   https://api.github.com/user
 *   Emails:    https://api.github.com/user/emails
 *
 * GitHub does NOT support PKCE — the token endpoint accepts but
 * ignores `code_verifier`. We send it anyway to keep the dance code
 * uniform.
 *
 * If the user has "Keep my email addresses private" set, GET /user
 * returns `email: null`. We call /user/emails (requires `user:email`
 * scope) and pick the primary verified one.
 *
 * Default scopes: `read:user user:email`.
 */

const DEFAULT_SCOPES = ['read:user', 'user:email'];

function readConfig(env) {
  return {
    clientId:     env.OAUTH_GITHUB_CLIENT_ID || null,
    clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET || null,
    scopes:       env.OAUTH_GITHUB_SCOPES ? env.OAUTH_GITHUB_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES,
  };
}

function enabled(config) {
  return Boolean(config.clientId && config.clientSecret);
}

function buildAuthorizeUrl({ config, redirectUri, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(' '),
    state,
    allow_signup: 'true',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function exchangeCode({ config, code, redirectUri, fetchImpl }) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    const err = new Error(`github token exchange failed: ${json.error || res.status} ${json.error_description || ''}`.trim());
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function fetchProfile({ tokens, fetchImpl }) {
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'davepi-plugin-oauth',
  };
  const res = await fetchImpl('https://api.github.com/user', { headers });
  const json = await res.json();
  if (!res.ok || !json.id) {
    const err = new Error(`github profile fetch failed: ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  let email = json.email || null;
  let emailVerified = false;
  if (!email) {
    // Private email — fetch the verified primary.
    const emailsRes = await fetchImpl('https://api.github.com/user/emails', { headers });
    if (emailsRes.ok) {
      const emails = await emailsRes.json();
      if (Array.isArray(emails)) {
        const primary = emails.find((e) => e && e.primary && e.verified)
          || emails.find((e) => e && e.verified)
          || emails[0];
        if (primary) {
          email = primary.email || null;
          emailVerified = Boolean(primary.verified);
        }
      }
    }
  } else {
    // GitHub's /user payload doesn't expose verification for the
    // public email — treat as verified-by-GitHub since the user
    // chose to make it public.
    emailVerified = true;
  }

  return {
    providerUserId: String(json.id),
    email,
    emailVerified,
    name: json.name || json.login || null,
    firstName: null,
    lastName: null,
    avatar: json.avatar_url || null,
    raw: json,
  };
}

module.exports = {
  id: 'github',
  displayName: 'GitHub',
  supportsPkce: false,
  readConfig,
  enabled,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProfile,
};
