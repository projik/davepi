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
 *   - `registerSuccessHandler(fn)` (on the instance): host-app hook
 *     used with OAUTH_SUCCESS_MODE=handler — the handler takes over
 *     the login-success response so tokens never travel in a URL.
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
  successMode:    'OAUTH_SUCCESS_MODE',
  stateSecret:    'OAUTH_STATE_SECRET',
  defaultRoles:   'OAUTH_DEFAULT_ROLES',
};

function readGlobalConfig(env) {
  return {
    baseUrl:         env[ENV_KEYS.baseUrl] || null,
    successRedirect: env[ENV_KEYS.successRedirect] || null,
    failureRedirect: env[ENV_KEYS.failureRedirect] || null,
    successMode:     String(env[ENV_KEYS.successMode] || 'redirect').toLowerCase(),
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

/**
 * "Does this request prefer JSON over a browser redirect?"
 *
 * Used by the /link route: a top-level browser navigation cannot set
 * an Authorization header, so an SPA holding only a Bearer token
 * starts the link flow with an authed fetch() — but fetch() cannot
 * follow a cross-origin 302 to the provider (CORS-opaque). When the
 * caller signals JSON (explicit `Accept: application/json` or the
 * XHR convention header), we hand back `200 { url }` and let the SPA
 * do `location.href = url` itself. Top-level navigations send
 * `Accept: text/html,...` (no application/json), so they keep the
 * 302 behaviour.
 */
function prefersJson(req) {
  const headers = req.headers || {};
  const accept = String(headers.accept || '').toLowerCase();
  if (accept.includes('application/json')) return true;
  return String(headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';
}

/**
 * Append query params to an already-validated path-only returnTo.
 * The path may legitimately carry its own query (`/dashboard?tab=x`),
 * so pick `?` vs `&` accordingly. Values are URL-encoded.
 */
function appendQueryParams(pathOnly, params) {
  let out = pathOnly;
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const sep = out.includes('?') ? '&' : '?';
    out += `${sep}${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }
  return out;
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
    successHandler: typeof opts.successHandler === 'function' ? opts.successHandler : null,
  };

  /**
   * Host-app hook for OAUTH_SUCCESS_MODE=handler: `fn(req, res,
   * { tokens, user, returnTo, provider, created })` takes over the
   * login-success response entirely (the plugin writes nothing).
   * Lets the consumer implement e.g. a single-use token handoff so
   * tokens never appear in a URL. May be async; a thrown error
   * delegates to the framework's errorHandler like any other
   * callback failure.
   */
  function registerSuccessHandler(fn) {
    if (typeof fn !== 'function') {
      throw new Error('davepi-plugin-oauth: registerSuccessHandler expects a function');
    }
    state.successHandler = fn;
  }

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
      let linkOutcome;
      try {
        linkOutcome = await linkIdentityToUser({
          provider: providerId,
          profile,
          userId: parsed.linkedUserId,
          OAuthIdentity: state.OAuthIdentity,
        });
      } catch (err) {
        if (err && err.code === 'oauth_identity_owned_by_other') {
          // Re-shape as the framework's 409 and carry the validated
          // returnTo so the route handler can land the user back on
          // a readable dashboard page instead of a bare error body.
          const conflict = new state.errors.ConflictError(err.message);
          conflict.code = err.code;
          conflict.provider = providerId;
          conflict.returnTo = parsed.returnTo || null;
          throw conflict;
        }
        throw err;
      }
      const { identity, created } = linkOutcome;
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
            // OAUTH_SUCCESS_MODE=handler: the host app takes over the
            // response (e.g. to run a single-use token handoff) and
            // the plugin never serialises tokens into a URL.
            if (globalCfg.successMode === 'handler') {
              if (state.successHandler) {
                return await state.successHandler(req, res, {
                  tokens: result.tokens,
                  user: result.user,
                  returnTo: rt,
                  provider: id,
                  created: result.created,
                });
              }
              // Misconfiguration: handler mode without a registered
              // handler. Never fall back to tokens-in-URL — answer
              // JSON instead and log loudly.
              state.log.error(
                { plugin: 'oauth', provider: id },
                'OAUTH_SUCCESS_MODE=handler but no success handler is registered (call registerSuccessHandler); responding with JSON'
              );
            } else if (globalCfg.successRedirect) {
              // The redirect destination is ALWAYS env-configured.
              // result.returnTo (validated) is appended as a query
              // param so the SPA at the success-redirect origin can
              // route the user — but it never overrides the origin.
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
          // link mode: when the SPA passed a (validated, path-only)
          // returnTo, land the browser back there with a readable
          // `linked=<provider>` marker. JSON fallback when no
          // returnTo was carried in state.
          const linkRt = safeReturnTo(result.returnTo);
          if (linkRt) {
            return res.redirect(302, appendQueryParams(linkRt, { linked: id }));
          }
          return res.status(200).json({
            linked: true,
            provider: id,
            providerUserId: result.providerUserId,
            created: result.created,
          });
        } catch (err) {
          // 409 already-linked-to-another-user: when the link flow
          // carried a returnTo, surface the conflict as a readable
          // dashboard redirect (`?error=...`) instead of an error
          // page. Everything else delegates to the errorHandler.
          if (err && err.code === 'oauth_identity_owned_by_other') {
            const errRt = safeReturnTo(err.returnTo);
            if (errRt) {
              return res.redirect(302, appendQueryParams(errRt, {
                error: err.code,
                provider: err.provider || id,
              }));
            }
          }
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
            // SPA-friendly variant: an authed fetch() can't follow
            // the 302 to the provider (CORS-opaque), so JSON-asking
            // callers get the authorize URL to navigate themselves.
            if (prefersJson(req)) {
              return res.status(200).json({ url });
            }
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
    if (globalCfg.successMode !== 'redirect' && globalCfg.successMode !== 'handler') {
      log.warn(
        { plugin: 'oauth', successMode: globalCfg.successMode },
        "OAUTH_SUCCESS_MODE must be 'redirect' or 'handler'; falling back to 'redirect'"
      );
      globalCfg.successMode = 'redirect';
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
    registerSuccessHandler,
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
