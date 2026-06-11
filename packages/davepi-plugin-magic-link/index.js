'use strict';

/**
 * davepi-plugin-magic-link
 *
 * Passwordless email magic-link login for dAvePi. The framework ships
 * JWT + bcrypt password users (`/register`, `/login`) but no magic
 * links — this plugin adds them, reusing davepi's own primitives: it
 * mints a real davepi session via `utils/tokens.issueTokenPair` (so
 * the rest of the API accepts the token unchanged) and emails the
 * link via `utils/mailer` (which logs instead of sending outside
 * production).
 *
 * Routes (under MAGIC_LINK_PATH, default `/auth/magic-link`):
 *   - POST <path>/request  { email, name? } — always 204; never
 *     reveals whether the email already has an account. New emails
 *     get a user with an unguessable random password (sign-in is by
 *     link only) unless MAGIC_LINK_ALLOW_SIGNUP=false.
 *   - POST <path>/verify   { token } — atomic single-use claim, then
 *     a standard (access, refresh) pair. The response carries the
 *     token's `purpose` and any `meta` stored on it.
 *   - POST <path>/invite   { email, name?, note?, meta? }
 *     (authenticated) — generic invite. Arbitrary `meta` rides on the
 *     token and is returned at verify, but is REFUSED unless the host
 *     app registers an authoriser via `registerInviteAuthoriser`
 *     (confused-deputy defence — see lib/handlers.js).
 *
 * Token policy: only the SHA-256 hash of the emailed token is stored,
 * in a TTL-indexed `magic_link_token` collection. Verification
 * enforces expiry at read time; the TTL index just keeps the
 * collection from growing unbounded.
 *
 * Dormancy: the plugin stays dormant (warn + return) when
 * MAGIC_LINK_URL is unset, matching the postmark / twilio / oauth
 * posture — safe to declare in `davepi.plugins` before wiring the
 * frontend.
 *
 * Public surface:
 *   - default export: a plugin instance configured from process.env
 *   - `createPlugin({ env, User, issueTokenPair, sendMail, errors,
 *                     mongoose, MagicLinkToken, bcrypt, verifyAuth,
 *                     authLimiter, log })` for tests / advanced use
 *   - `registerInviteAuthoriser(fn)` (on the instance) — enables the
 *     invite route's `meta` and lets the host app enforce ownership
 *     checks; may return `{ userId }` to bind the link to a specific
 *     account.
 *   - `issueMagicLink({ email, userId, purpose, meta })` (on the
 *     instance) — programmatic minting for custom flows; returns the
 *     raw token.
 */

const { buildMagicLinkHandlers } = require('./lib/handlers');
const { getMagicLinkTokenModel } = require('./lib/models');

const ENV_KEYS = {
  url: 'MAGIC_LINK_URL',
  path: 'MAGIC_LINK_PATH',
  ttlMinutes: 'MAGIC_LINK_TTL_MINUTES',
  allowSignup: 'MAGIC_LINK_ALLOW_SIGNUP',
  defaultRoles: 'MAGIC_LINK_DEFAULT_ROLES',
  appName: 'APP_NAME',
};

// Numeric env reader clamped to [min, max] with a fallback — a
// typo'd MAGIC_LINK_TTL_MINUTES must never yield a NaN `expiresAt`
// (which would mint tokens that can never satisfy the expiry check).
function readInt(raw, def, { min, max } = {}) {
  if (raw == null || raw === '') return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  if (min != null && n < min) return def;
  if (max != null && n > max) return def;
  return n;
}

function readConfigFromEnv(env) {
  return {
    url: env[ENV_KEYS.url] || null,
    path: env[ENV_KEYS.path] || '/auth/magic-link',
    ttlMinutes: readInt(env[ENV_KEYS.ttlMinutes], 30, { min: 1, max: 1440 }),
    allowSignup: String(env[ENV_KEYS.allowSignup] || 'true') !== 'false',
    defaultRoles: env[ENV_KEYS.defaultRoles]
      ? env[ENV_KEYS.defaultRoles].split(/[\s,]+/).filter(Boolean)
      : ['user'],
    appName: env[ENV_KEYS.appName] || null,
  };
}

/**
 * Build a fresh plugin instance. Most consumers don't call this
 * directly — `require('davepi-plugin-magic-link')` returns a default
 * instance configured from `process.env`. Tests call it with injected
 * dependencies so the package's own unit suite runs without `davepi`,
 * `mongoose`, or `bcryptjs` installed.
 */
function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const config = readConfigFromEnv(env);

  const noopLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noopLog,
  };

  const state = {
    enabled: false,
    config,
    appName: 'dAvePi',
    log: opts.log || noopLog,
    // Injected / lazily resolved framework dependencies.
    errors: opts.errors || null,
    User: opts.User || null,
    issueTokenPair: opts.issueTokenPair || null,
    sendMail: opts.sendMail || null,
    bcrypt: opts.bcrypt || null,
    mongoose: opts.mongoose || null,
    MagicLinkToken: opts.MagicLinkToken || null,
    verifyAuth: opts.verifyAuth || null,
    authLimiter: opts.authLimiter || null,
    authoriseInvite:
      typeof opts.authoriseInvite === 'function' ? opts.authoriseInvite : null,
  };

  let handlers = null;

  function registerInviteAuthoriser(fn) {
    if (typeof fn !== 'function') {
      throw new Error(
        'davepi-plugin-magic-link: registerInviteAuthoriser expects a function'
      );
    }
    state.authoriseInvite = fn;
  }

  async function issueMagicLink(input) {
    if (!state.enabled || !handlers) {
      throw new Error(
        'davepi-plugin-magic-link: issueMagicLink called but plugin is dormant ' +
          '(MAGIC_LINK_URL not set or setup not run yet)'
      );
    }
    return handlers.issueMagicLink(input);
  }

  // Resolve a framework module lazily; returns null (after logging)
  // when it can't be required, so the plugin can go dormant instead
  // of failing the host's boot.
  function lazyRequire(specifier, why) {
    try {
      return require(specifier);
    } catch (err) {
      state.log.error(
        { err, plugin: 'magic-link' },
        `could not require '${specifier}' (${why}); davepi-plugin-magic-link is dormant`
      );
      return null;
    }
  }

  async function setup({ app, schemaLoader, bus, log, appName } = {}) {
    if (log) state.log = log;

    if (!config.url) {
      state.log.warn(
        { plugin: 'magic-link' },
        'MAGIC_LINK_URL not set; davepi-plugin-magic-link is dormant'
      );
      return;
    }

    state.appName = config.appName || appName || 'dAvePi';

    if (!state.errors) {
      state.errors = lazyRequire('davepi/utils/errors', 'error constructors');
      if (!state.errors) return;
    }
    if (!state.User) {
      state.User = lazyRequire('davepi/model/user', 'user model');
      if (!state.User) return;
    }
    if (!state.issueTokenPair) {
      const tokens = lazyRequire('davepi/utils/tokens', 'session issuance');
      if (!tokens) return;
      state.issueTokenPair = tokens.issueTokenPair;
    }
    if (!state.sendMail) {
      const mailer = lazyRequire('davepi/utils/mailer', 'email delivery');
      if (!mailer) return;
      state.sendMail = mailer.sendMail;
    }
    if (!state.bcrypt) {
      state.bcrypt = lazyRequire('bcryptjs', 'password hashing');
      if (!state.bcrypt) return;
    }
    if (!state.MagicLinkToken) {
      const mongooseInstance =
        state.mongoose || lazyRequire('mongoose', 'token store');
      if (!mongooseInstance) return;
      state.MagicLinkToken = getMagicLinkTokenModel(mongooseInstance);
    }
    if (!state.verifyAuth) {
      state.verifyAuth = lazyRequire(
        'davepi/middleware/auth',
        'invite route auth gate'
      );
      if (!state.verifyAuth) return;
    }
    if (!state.authLimiter) {
      const rateLimit = lazyRequire(
        'davepi/middleware/rateLimit',
        'public route rate limiting'
      );
      if (!rateLimit) return;
      state.authLimiter = rateLimit.authLimiter;
    }

    handlers = buildMagicLinkHandlers({ config, state });
    state.enabled = true;

    if (!app || typeof app.post !== 'function') {
      state.log.info(
        { plugin: 'magic-link' },
        'davepi-plugin-magic-link ready (no Express app; routes not mounted)'
      );
      return;
    }

    app.post(`${config.path}/request`, state.authLimiter, handlers.request);
    app.post(`${config.path}/verify`, state.authLimiter, handlers.verify);
    app.post(`${config.path}/invite`, state.verifyAuth(true), handlers.invite);

    state.log.info(
      { plugin: 'magic-link', path: config.path },
      'davepi-plugin-magic-link routes mounted'
    );
  }

  return {
    name: 'magic-link',
    setup,
    registerInviteAuthoriser,
    issueMagicLink,
    isEnabled: () => state.enabled,
    // Test-only / advanced introspection.
    _state: state,
  };
}

const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
