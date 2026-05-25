'use strict';

/**
 * davepi-plugin-oauth
 *
 * Social login for dAvePi. Mounts `/auth/{provider}` and
 * `/auth/{provider}/callback` (plus `/link` variants for binding a
 * provider to an already-authenticated user) and issues the
 * framework's standard JWT on success.
 *
 * Providers are enabled per-environment: a provider whose client id
 * + secret are both set in the env gets its routes mounted; one
 * with missing env stays dormant. The plugin as a whole stays
 * dormant only when *no* provider is configured — matching the
 * postmark posture.
 *
 * Public surface:
 *   - default export: a plugin instance configured from process.env
 *   - `createPlugin({ env, fetch, providers, mongoose, OAuthIdentity,
 *                     User, issueTokenPair, errors })` for tests /
 *     advanced consumers.
 *
 * State CSRF defence: every authorize URL carries an HMAC-signed
 * `state` that encodes `{ nonce, ts, returnTo?, linkedUserId? }`.
 * Callbacks reject mismatched / expired / unsigned states. PKCE
 * verifier travels in the same signed payload so the callback can
 * recover it without server-side session storage.
 *
 * Token policy: the provider's access_token is NOT persisted by
 * default — we only need the profile to mint our JWT. Persisting
 * provider tokens for ongoing API access is a separate "linked-
 * token store" concern.
 */

const path = require('path');

const providersBuiltIn = require('./lib/providers');
const { sealState, openState, signState, verifyState } = require('./lib/state');
const { generatePair } = require('./lib/pkce');
const { findOrCreateUser, linkIdentityToUser } = require('./lib/link');
const { getOAuthIdentityModel } = require('./lib/identity');

const ENV_KEYS = {
  baseUrl:        'OAUTH_BASE_URL',
  successRedirect:'OAUTH_SUCCESS_REDIRECT',
  failureRedirect:'OAUTH_FAILURE_REDIRECT',
  stateSecret:    'OAUTH_STATE_SECRET',
  defaultRoles:   'OAUTH_DEFAULT_ROLES',
};

function readGlobalConfig(env) {
  return {
    baseUrl:         env[ENV_KEYS.baseUrl] || null,
    successRedirect: env[ENV_KEYS.successRedirect] || null,
    failureRedirect: env[ENV_KEYS.failureRedirect] || null,
    stateSecret:     env[ENV_KEYS.stateSecret] || null,
    defaultRoles:    env[ENV_KEYS.defaultRoles]
      ? env[ENV_KEYS.defaultRoles].split(/[\s,]+/).filter(Boolean)
      : ['user'],
  };
}

function joinUrl(base, p) {
  return `${base.replace(/\/+$/, '')}${p.startsWith('/') ? p : `/${p}`}`;
}

/**
 * `returnTo` is a caller-supplied hint at /auth/{provider}?returnTo=...
 * that travels in the (now encrypted) state and is appended to the
 * success-redirect URL after the tokens, so the SPA at the
 * success-redirect origin can route the user to the page they came
 * from. Crucially, returnTo is NEVER used as the redirect destination
 * itself — that would be an open-redirect-with-JWT exfiltration sink
 * (an attacker initiates a real flow with `returnTo=https://evil/`,
 * tricks a victim into clicking, tokens land on evil.example).
 *
 * This validator accepts ONLY safe relative paths: must start with
 * `/`, must not be protocol-relative (`//foo` is rejected), must not
 * contain `://`, must be ≤ 1024 chars. Anything else returns null —
 * the caller should drop it silently.
 */
function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.length) return null;
  if (value.length > 1024) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.includes('://')) return null;
  return value;
}

function appendTokenToRedirect(redirect, accessToken, refreshToken, returnTo) {
  // Two supported posters:
  //   - URL ending in `=` (e.g. `https://app/auth/success?token=`):
  //     just concatenate, so the value is URL-safe.
  //   - URL not ending in `=`: append as `?token=...` or `&token=...`.
  let out;
  if (redirect.endsWith('=')) {
    out = `${redirect}${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`;
  } else {
    const sep = redirect.includes('?') ? '&' : '?';
    out = `${redirect}${sep}token=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`;
  }
  if (returnTo) {
    out += `&returnTo=${encodeURIComponent(returnTo)}`;
  }
  return out;
}

/**
 * Plugin-local body parser for `application/x-www-form-urlencoded`.
 * The framework's main app only mounts `express.json()`, so Apple's
 * `response_mode=form_post` callbacks would otherwise arrive with an
 * empty body. We avoid pulling `express` (peer-dep-only) by writing
 * a tiny parser around Node's built-in `URLSearchParams`.
 *
 * Skip-on-already-parsed: a host app that mounts `express.urlencoded`
 * globally is honoured — we don't double-parse.
 *
 * 1MB cap mirrors express's default urlencoded limit; oversized
 * bodies are aborted with a 413 via `next(err)`.
 */
function parseUrlEncodedBody(req, res, next) {
  if (req.method !== 'POST') return next();
  if (req.body && Object.keys(req.body).length) return next();
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/x-www-form-urlencoded')) return next();
  let data = '';
  let aborted = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    if (aborted) return;
    data += chunk;
    if (data.length > 1_000_000) {
      aborted = true;
      const err = new Error('request entity too large');
      err.status = 413;
      next(err);
    }
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const body = {};
      for (const [k, v] of new URLSearchParams(data)) body[k] = v;
      req.body = body;
      next();
    } catch (err) {
      next(err);
    }
  });
  req.on('error', (err) => { if (!aborted) next(err); });
}

function pickProviders(env, providerSet) {
  const enabled = {};
  for (const [id, adapter] of Object.entries(providerSet)) {
    const cfg = adapter.readConfig(env);
    if (adapter.enabled(cfg)) enabled[id] = { adapter, config: cfg };
  }
  return enabled;
}

function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const providerSet = opts.providers || providersBuiltIn;
  const injectedUser = opts.User || null;
  const injectedIdentity = opts.OAuthIdentity || null;
  const injectedIssue = opts.issueTokenPair || null;
  const injectedErrors = opts.errors || null;
  const injectedMongoose = opts.mongoose || null;
  const injectedFs = opts.fs || null;

  // verifyAuth lets tests assert the route flow without spinning up a
  // real auth middleware. In production we resolve davepi's
  // `middleware/auth` at setup time.
  const injectedVerifyAuth = opts.verifyAuth || null;

  const globalCfg = readGlobalConfig(env);

  const state = {
    enabled: false,
    providers: {}, // id -> { adapter, config, callbackUrl, linkCallbackUrl }
    log: null,
    User: null,
    OAuthIdentity: null,
    issueTokenPair: null,
    errors: null,
    verifyAuth: injectedVerifyAuth,
  };

  function callbackUrlFor(id) {
    return joinUrl(globalCfg.baseUrl, `/auth/${id}/callback`);
  }
  function linkCallbackUrlFor(id) {
    return joinUrl(globalCfg.baseUrl, `/auth/${id}/link/callback`);
  }

  function ensureEnabled(call) {
    if (!state.enabled) {
      throw new Error(`davepi-plugin-oauth: ${call} called but plugin is dormant`);
    }
  }

  function buildAuthorizeRedirect(providerId, { linkedUserId, returnTo } = {}) {
    ensureEnabled('buildAuthorizeRedirect');
    const entry = state.providers[providerId];
    if (!entry) {
      throw new Error(`davepi-plugin-oauth: provider "${providerId}" is not enabled`);
    }
    const { adapter, config } = entry;
    const pair = adapter.supportsPkce ? generatePair() : null;
    // `returnTo` is path-only — see safeReturnTo above. Defence in
    // depth: even if a caller hands us junk programmatically, drop
    // it here rather than at the route boundary alone.
    const safeRT = safeReturnTo(returnTo);
    const stateToken = sealState({
      provider: providerId,
      linkedUserId: linkedUserId || null,
      returnTo: safeRT,
      verifier: pair ? pair.verifier : null,
    }, { secret: globalCfg.stateSecret });
    const redirectUri = linkedUserId ? linkCallbackUrlFor(providerId) : callbackUrlFor(providerId);
    const url = adapter.buildAuthorizeUrl({
      config,
      redirectUri,
      state: stateToken,
      codeChallenge: pair ? pair.challenge : null,
    });
    return { url, redirectUri };
  }

  async function handleCallback(providerId, { code, stateToken, extraParams } = {}) {
    ensureEnabled('handleCallback');
    const entry = state.providers[providerId];
    if (!entry) {
      throw new state.errors.NotFoundError(`provider "${providerId}" is not enabled`);
    }
    if (!code) {
      throw new state.errors.ValidationError('missing code');
    }
    let parsed;
    try {
      parsed = openState(stateToken, { secret: globalCfg.stateSecret });
    } catch (err) {
      throw new state.errors.UnauthorizedError(`state verification failed: ${err.message}`);
    }
    if (parsed.provider && parsed.provider !== providerId) {
      throw new state.errors.UnauthorizedError('state provider mismatch');
    }
    const { adapter, config } = entry;
    const isLink = Boolean(parsed.linkedUserId);
    const redirectUri = isLink ? linkCallbackUrlFor(providerId) : callbackUrlFor(providerId);
    const tokens = await adapter.exchangeCode({
      config,
      code,
      redirectUri,
      codeVerifier: parsed.verifier || null,
      fetchImpl,
      fs: injectedFs,
    });
    const profile = await adapter.fetchProfile({ tokens, fetchImpl, extraParams });

    if (isLink) {
      const { identity, created } = await linkIdentityToUser({
        provider: providerId,
        profile,
        userId: parsed.linkedUserId,
        OAuthIdentity: state.OAuthIdentity,
      });
      return {
        mode: 'link',
        linked: true,
        provider: providerId,
        providerUserId: profile.providerUserId,
        userId: parsed.linkedUserId,
        identity,
        created,
        returnTo: parsed.returnTo || null,
      };
    }

    const { user, identity, created } = await findOrCreateUser({
      provider: providerId,
      profile,
      User: state.User,
      OAuthIdentity: state.OAuthIdentity,
      defaultRoles: globalCfg.defaultRoles,
    });
    const issued = await state.issueTokenPair(user, null);
    return {
      mode: 'login',
      provider: providerId,
      user,
      identity,
      created,
      tokens: issued,
      returnTo: parsed.returnTo || null,
    };
  }

  function mountRoutes(app) {
    for (const id of Object.keys(state.providers)) {
      app.get(`/auth/${id}`, async (req, res, next) => {
        try {
          // returnTo is sanitised at the route boundary AND inside
          // buildAuthorizeRedirect — defence in depth. Junk values
          // become null and are simply dropped.
          const { url } = buildAuthorizeRedirect(id, {
            returnTo: safeReturnTo(req.query && req.query.returnTo) || null,
          });
          res.redirect(302, url);
        } catch (err) { next(err); }
      });

      // Apple sends the callback as POST form-urlencoded when
      // response_mode=form_post; the others as GET. Mount both
      // verbs so the same handler covers both, and run the
      // urlencoded parser on POSTs (the framework only mounts
      // express.json() globally).
      const cbHandler = async (req, res, next) => {
        try {
          const params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
          const code = params.code;
          const stateToken = params.state;
          if (params.error) {
            return failureResponse(res, next, `${id} returned error: ${params.error}`);
          }
          const result = await handleCallback(id, { code, stateToken, extraParams: params });
          if (result.mode === 'login') {
            const { accessToken, refreshToken } = result.tokens;
            const rt = safeReturnTo(result.returnTo);
            // The redirect destination is ALWAYS env-configured.
            // result.returnTo (validated) is appended as a query
            // param so the SPA at the success-redirect origin can
            // route the user — but it never overrides the origin.
            if (globalCfg.successRedirect) {
              return res.redirect(302, appendTokenToRedirect(
                globalCfg.successRedirect, accessToken, refreshToken, rt
              ));
            }
            return res.status(200).json({
              accessToken,
              refreshToken,
              user: serialiseUser(result.user),
              provider: id,
              created: result.created,
              returnTo: rt,
            });
          }
          // link mode
          return res.status(200).json({
            linked: true,
            provider: id,
            providerUserId: result.providerUserId,
            created: result.created,
          });
        } catch (err) {
          next(err);
        }
      };
      app.get(`/auth/${id}/callback`, cbHandler);
      app.post(`/auth/${id}/callback`, parseUrlEncodedBody, cbHandler);

      // Link flow: require an existing JWT, then re-enter the dance
      // with `linkedUserId` baked into the signed state. The
      // callback goes through the same handler — `linkedUserId`
      // tells it which branch to take.
      app.get(`/auth/${id}/link`, (req, res, next) => {
        const authMw = state.verifyAuth(true);
        return authMw(req, res, (authErr) => {
          if (authErr) return next(authErr);
          try {
            const userId = req.user && (req.user.user_id || req.user._id || req.user.id);
            if (!userId) return next(new state.errors.UnauthorizedError('not authenticated'));
            const { url } = buildAuthorizeRedirect(id, {
              linkedUserId: String(userId),
              returnTo: safeReturnTo(req.query && req.query.returnTo) || null,
            });
            res.redirect(302, url);
          } catch (err) { next(err); }
        });
      });
      app.get(`/auth/${id}/link/callback`, cbHandler);
      app.post(`/auth/${id}/link/callback`, parseUrlEncodedBody, cbHandler);
    }
  }

  // Provider-returned errors take one of two shapes: redirect the
  // browser to the configured failure URL (a normal response, not
  // an error), or — when no failure URL is configured — surface
  // through the framework's centralised errorHandler via next(err)
  // so the response shape matches every other 4xx the framework
  // emits. No inline `res.status(400).json(...)`.
  function failureResponse(res, next, message) {
    if (globalCfg.failureRedirect) {
      const sep = globalCfg.failureRedirect.includes('?') ? '&' : '?';
      return res.redirect(302, `${globalCfg.failureRedirect}${sep}error=${encodeURIComponent(message)}`);
    }
    return next(new state.errors.ValidationError(message));
  }

  function serialiseUser(user) {
    if (!user) return null;
    return {
      _id: user._id,
      first_name: user.first_name,
      last_name:  user.last_name,
      email:      user.email,
      roles:      user.roles,
    };
  }

  async function setup({ app, schemaLoader, bus, log, appName }) {
    state.log = log;

    const enabledProviders = pickProviders(env, providerSet);
    if (!Object.keys(enabledProviders).length) {
      log.warn(
        { plugin: 'oauth' },
        'no providers configured (set OAUTH_{PROVIDER}_CLIENT_ID/_SECRET); davepi-plugin-oauth is dormant'
      );
      return;
    }
    if (!globalCfg.baseUrl) {
      log.error(
        { plugin: 'oauth' },
        'OAUTH_BASE_URL is required when any provider is enabled; davepi-plugin-oauth is dormant'
      );
      return;
    }
    if (!globalCfg.stateSecret || globalCfg.stateSecret.length < 16) {
      log.error(
        { plugin: 'oauth' },
        'OAUTH_STATE_SECRET is required (>= 16 chars) when any provider is enabled; davepi-plugin-oauth is dormant'
      );
      return;
    }

    // Resolve framework integration points lazily so the package's
    // own tests (which don't install davepi) still load.
    let errors = injectedErrors;
    if (!errors) {
      try { errors = require('davepi/utils/errors'); }
      catch (err) {
        log.error({ err, plugin: 'oauth' },
          "could not require 'davepi/utils/errors'; davepi-plugin-oauth is dormant");
        return;
      }
    }
    state.errors = errors;

    let issueTokenPair = injectedIssue;
    if (!issueTokenPair) {
      try { issueTokenPair = require('davepi/utils/tokens').issueTokenPair; }
      catch (err) {
        log.error({ err, plugin: 'oauth' },
          "could not require 'davepi/utils/tokens'; davepi-plugin-oauth is dormant");
        return;
      }
    }
    state.issueTokenPair = issueTokenPair;

    let User = injectedUser;
    if (!User) {
      try { User = require('davepi/model/user'); }
      catch (err) {
        log.error({ err, plugin: 'oauth' },
          "could not require 'davepi/model/user'; davepi-plugin-oauth is dormant");
        return;
      }
    }
    state.User = User;

    let OAuthIdentity = injectedIdentity;
    if (!OAuthIdentity) {
      OAuthIdentity = getOAuthIdentityModel(injectedMongoose);
    }
    state.OAuthIdentity = OAuthIdentity;

    if (!state.verifyAuth) {
      try { state.verifyAuth = require('davepi/middleware/auth'); }
      catch (err) {
        log.warn({ err, plugin: 'oauth' },
          "could not require 'davepi/middleware/auth'; /link routes will reject");
        state.verifyAuth = () => (_req, _res, next) => next(new errors.UnauthorizedError('auth middleware unavailable'));
      }
    }

    state.providers = enabledProviders;
    state.enabled = true;

    if (app) mountRoutes(app);

    log.info(
      { plugin: 'oauth', providers: Object.keys(enabledProviders) },
      'davepi-plugin-oauth ready'
    );
  }

  return {
    name: 'oauth',
    setup,
    // helpers exposed for advanced consumers / tests
    buildAuthorizeRedirect,
    handleCallback,
    isEnabled: () => state.enabled,
    enabledProviders: () => Object.keys(state.providers),
  };
}

const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
module.exports.providers = providersBuiltIn;
module.exports.signState = signState;
module.exports.verifyState = verifyState;
