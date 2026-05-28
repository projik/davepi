'use strict';

/**
 * davepi-plugin-twilio
 *
 * One package covering Twilio's most common surfaces for a dAvePi
 * consumer:
 *
 *   - sendSms / sendWhatsApp for transactional / notification sends
 *     (from a schema lifecycle hook, an ad-hoc route, or anywhere).
 *   - POST /auth/otp + POST /auth/otp/verify: passwordless SMS login.
 *     Generates a short-lived code, stores its sha256 hash in
 *     `otp_challenge` (TTL-indexed), rate-limits per phone via
 *     `otp_rate`, and on a successful verify upserts a User by `phone`
 *     and issues the framework's standard JWT via
 *     `utils/tokens.issueTokenPair`.
 *   - POST /auth/2fa/enroll + /verify + /challenge: TOTP-based second
 *     factor. The shared secret is encrypted at rest with AES-256-GCM
 *     keyed off `TOKEN_KEY`, eight base32 backup codes are issued at
 *     enrollment (returned once, then hashed), and `/challenge` mints
 *     a fresh JWT given a valid current TOTP or a one-shot backup
 *     code.
 *   - POST <TWILIO_INBOUND_PATH>: inbound SMS webhook with
 *     `X-Twilio-Signature` verification and a setImmediate fan-out so
 *     a slow subscriber never causes Twilio to retry.
 *
 * Why one plugin covers both transactional and auth use cases: a
 * consumer wiring Twilio for receipt SMS already has the Twilio
 * account, the auth-token secret, and the failure-isolation posture
 * sorted; splitting them into two packages would duplicate config and
 * obscure the fact that an outage on the same Twilio account
 * propagates to every surface together.
 *
 * Dormancy: the plugin stays dormant when TWILIO_ACCOUNT_SID is
 * unset. Calls to sendSms / sendWhatsApp throw with a clear message;
 * routes are not mounted. This matches the postmark / slack posture
 * so a consumer can ship the package in a project before turning
 * Twilio on.
 */

const { EventEmitter } = require('events');

const { sendSms: sendSmsImpl, sendWhatsApp: sendWhatsAppImpl } = require('./lib/sms');
const { buildOtpHandlers } = require('./lib/otp');
const { buildTotpHandlers, encrypt, decrypt } = require('./lib/totp');
const { buildInboundHandler, defaultUrlencodedParser } = require('./lib/inbound');

const ENV_KEYS = {
  accountSid:          'TWILIO_ACCOUNT_SID',
  authToken:           'TWILIO_AUTH_TOKEN',
  fromNumber:          'TWILIO_FROM_NUMBER',
  messagingServiceSid: 'TWILIO_MESSAGING_SERVICE_SID',
  whatsappFrom:        'TWILIO_WHATSAPP_FROM',
  inboundPath:         'TWILIO_INBOUND_PATH',
  otpPath:             'OTP_PATH',
  otpDigits:           'OTP_DIGITS',
  otpTtlSeconds:       'OTP_TTL_SECONDS',
  otpMaxPerHour:       'OTP_MAX_ATTEMPTS_PER_HOUR',
  twilioAppName:       'TWILIO_APP_NAME',
  appName:             'APP_NAME',
  tokenKey:            'TOKEN_KEY',
};

function readConfigFromEnv(env) {
  return {
    accountSid:          env[ENV_KEYS.accountSid] || null,
    authToken:           env[ENV_KEYS.authToken] || null,
    fromNumber:          env[ENV_KEYS.fromNumber] || null,
    messagingServiceSid: env[ENV_KEYS.messagingServiceSid] || null,
    whatsappFrom:        env[ENV_KEYS.whatsappFrom] || null,
    inboundPath:         env[ENV_KEYS.inboundPath] || null,
    otpPath:             env[ENV_KEYS.otpPath] != null ? env[ENV_KEYS.otpPath] : '/auth/otp',
    otpDigits:           parseInt(env[ENV_KEYS.otpDigits] || '6', 10),
    otpTtlSeconds:       parseInt(env[ENV_KEYS.otpTtlSeconds] || '600', 10),
    otpMaxPerHour:       parseInt(env[ENV_KEYS.otpMaxPerHour] || '5', 10),
    twilioAppName:       env[ENV_KEYS.twilioAppName] || null,
    appName:             env[ENV_KEYS.appName] || null,
    tokenKey:            env[ENV_KEYS.tokenKey] || null,
  };
}

/**
 * Build a fresh plugin instance. Most consumers don't call this
 * directly — `require('davepi-plugin-twilio')` returns a default
 * instance configured from `process.env`. Tests call it with
 * injected dependencies so the package's own unit suite can run
 * without `twilio`, `otplib`, `libphonenumber-js`, or `mongoose`
 * installed.
 *
 * Options (all optional):
 *   - env:            object — env vars source, defaults to process.env
 *   - twilioClient:   pre-built Twilio client (tests). When omitted,
 *                     setup() lazy-loads the `twilio` SDK and builds
 *                     one from the env credentials.
 *   - fetch:          unused today; reserved for future REST fallbacks
 *   - errors:         framework error constructors. Defaults to a
 *                     lazy `require('davepi/utils/errors')` at setup
 *                     time.
 *   - mongoose:       a mongoose instance (tests). When omitted,
 *                     setup() lazy-loads the peer-dep mongoose.
 *   - OtpChallenge:   override the OtpChallenge model (tests).
 *   - OtpRate:        override the OtpRate model (tests).
 *   - User:           override the User model (tests). Defaults to
 *                     `davepi/model/user` at setup time.
 *   - issueTokenPair: override token issuance (tests). Defaults to
 *                     `davepi/utils/tokens.issueTokenPair`.
 *   - totp:           override otplib's authenticator interface
 *                     (tests). Defaults to a lazy
 *                     `require('otplib').authenticator`.
 *   - log:            framework pino instance (tests).
 */
function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const config = readConfigFromEnv(env);

  const inboundEmitter = new EventEmitter();
  inboundEmitter.setMaxListeners(0);

  // Runtime state — populated by setup(). Pre-setup `state.enabled
  // === false` so `sendSms` and friends throw with a clear pointer
  // at the missing env var.
  const state = {
    enabled:             false,
    client:              opts.twilioClient || null,
    accountSid:          null,
    authToken:           null,
    fromNumber:          null,
    messagingServiceSid: null,
    whatsappFrom:        null,
    appName:             'dAvePi',
    config,
    // Injected/lazy
    errors:        opts.errors || null,
    mongoose:      opts.mongoose || null,
    OtpChallenge:  opts.OtpChallenge || null,
    OtpRate:       opts.OtpRate || null,
    User:          opts.User || null,
    issueTokenPair: opts.issueTokenPair || null,
    totp:          opts.totp || null,
    log:           opts.log || null,
  };

  function ensureEnabled(call) {
    if (!state.enabled || !state.client) {
      throw new Error(
        `davepi-plugin-twilio: ${call} called but plugin is dormant ` +
        '(TWILIO_ACCOUNT_SID not set or setup not run yet)'
      );
    }
  }

  async function sendSms(input) {
    ensureEnabled('sendSms');
    return sendSmsImpl(state.client, state, input);
  }
  async function sendWhatsApp(input) {
    ensureEnabled('sendWhatsApp');
    return sendWhatsAppImpl(state.client, state, input);
  }

  function onInboundSms(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('davepi-plugin-twilio: onInboundSms handler must be a function');
    }
    inboundEmitter.on('sms', handler);
    return () => inboundEmitter.off('sms', handler);
  }

  /**
   * Verify a TOTP code (or a one-shot backup code) for a known user.
   * Used by the `/auth/2fa/challenge` route and exposed publicly so a
   * consumer's custom `/login` hook can call it directly. Returns
   * `true` on success, `false` otherwise. On a successful backup-code
   * use, the hash is removed from the user's `backupCodeHashes`.
   */
  async function verifyTotpForUser(userId, code) {
    ensureEnabled('verifyTotpForUser');
    if (!state.User) throw new Error('davepi-plugin-twilio: User model not available');
    const user = await state.User.findById(userId);
    if (!user || !user.twofaEnabled || !user.totpSecretEnc) return false;
    const secret = decrypt(user.totpSecretEnc, state.config.tokenKey);
    if (state.totp && state.totp.verify({ token: code, secret })) return true;
    // Backup code fallback: code may be a base32 12-char backup code.
    const codeHash = require('crypto').createHash('sha256').update(String(code || '')).digest('hex');
    const hashes = Array.isArray(user.backupCodeHashes) ? user.backupCodeHashes : [];
    const idx = hashes.indexOf(codeHash);
    if (idx === -1) return false;
    const remaining = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
    await state.User.findByIdAndUpdate(userId, { backupCodeHashes: remaining }, { strict: false });
    return true;
  }

  async function setup({ app, schemaLoader, bus, log, appName } = {}) {
    state.log = log || state.log || console;

    if (!config.accountSid) {
      state.log.warn(
        { plugin: 'twilio' },
        'TWILIO_ACCOUNT_SID not set; davepi-plugin-twilio is dormant'
      );
      return;
    }
    if (!config.authToken && !state.client) {
      // We allow a pre-built client (tests) to stand in for auth-token
      // creds. Otherwise, both are required.
      state.log.error(
        { plugin: 'twilio' },
        'TWILIO_AUTH_TOKEN not set; davepi-plugin-twilio is dormant'
      );
      return;
    }

    // Lazy-load Twilio SDK only if a client wasn't injected. This
    // keeps the unit-test suite green without `twilio` installed.
    if (!state.client) {
      try {
        const twilio = require('twilio');
        state.client = twilio(config.accountSid, config.authToken);
      } catch (err) {
        state.log.error(
          { err, plugin: 'twilio' },
          'could not require `twilio` SDK; davepi-plugin-twilio is dormant'
        );
        return;
      }
    }

    state.accountSid          = config.accountSid;
    state.authToken           = config.authToken;
    state.fromNumber          = config.fromNumber;
    state.messagingServiceSid = config.messagingServiceSid;
    state.whatsappFrom        = config.whatsappFrom;
    state.appName             = config.twilioAppName || config.appName || appName || 'dAvePi';
    state.enabled             = true;

    // Resolve framework dependencies lazily so the unit tests (which
    // don't install `davepi`) can stub them via createPlugin opts.
    if (!state.errors) {
      try { state.errors = require('davepi/utils/errors'); }
      catch (err) {
        state.log.error({ err, plugin: 'twilio' }, "could not require 'davepi/utils/errors'; routes not mounted");
        return;
      }
    }
    if (!state.User) {
      try { state.User = require('davepi/model/user'); }
      catch (err) {
        state.log.warn({ err, plugin: 'twilio' }, "could not require 'davepi/model/user'; auth routes will fail");
      }
    }
    if (!state.issueTokenPair) {
      try { state.issueTokenPair = require('davepi/utils/tokens').issueTokenPair; }
      catch (err) {
        state.log.warn({ err, plugin: 'twilio' }, "could not require 'davepi/utils/tokens'; auth routes will fail");
      }
    }
    if (!state.totp) {
      try { state.totp = require('otplib').authenticator; }
      catch (err) {
        state.log.warn({ err, plugin: 'twilio' }, "could not require 'otplib'; 2FA routes will fail");
      }
    }
    if (!state.OtpChallenge || !state.OtpRate) {
      try {
        const m = state.mongoose || require('mongoose');
        const models = require('./lib/models');
        if (!state.OtpChallenge) state.OtpChallenge = models.getOtpChallengeModel(m);
        if (!state.OtpRate) state.OtpRate = models.getOtpRateModel(m);
      } catch (err) {
        state.log.warn({ err, plugin: 'twilio' }, "could not load Mongoose OTP models; OTP routes will fail");
      }
    }

    if (!app || typeof app.post !== 'function') {
      state.log.info({ plugin: 'twilio' }, 'davepi-plugin-twilio ready (no Express app; routes not mounted)');
      return;
    }

    // ---- OTP routes ----
    if (config.otpPath) {
      const handlers = buildOtpHandlers({
        config,
        state,
        sendSms,
      });
      app.post(config.otpPath, handlers.send);
      app.post(`${config.otpPath}/verify`, handlers.verify);
      state.log.info(
        { plugin: 'twilio', path: config.otpPath },
        'davepi-plugin-twilio OTP routes mounted'
      );
    }

    // ---- 2FA routes ----
    const totpHandlers = buildTotpHandlers({ config, state, verifyTotpForUser });
    // Resolve auth middleware lazily.
    let verifyToken = opts.verifyToken;
    if (!verifyToken) {
      try { verifyToken = require('davepi/middleware/auth'); }
      catch (err) {
        state.log.warn({ err, plugin: 'twilio' }, "could not require 'davepi/middleware/auth'; 2FA routes mounted without auth gate");
        verifyToken = () => (req, res, next) => next();
      }
    }
    app.post('/auth/2fa/enroll', verifyToken(true), totpHandlers.enroll);
    app.post('/auth/2fa/verify', verifyToken(true), totpHandlers.verify);
    app.post('/auth/2fa/challenge', totpHandlers.challenge);

    // ---- Inbound webhook ----
    if (config.inboundPath) {
      let validateRequest = state.client && typeof state.client.validateRequest === 'function'
        ? state.client.validateRequest.bind(state.client)
        : null;
      if (!validateRequest) {
        try {
          const twilio = require('twilio');
          validateRequest = (token, sig, url, params) =>
            twilio.validateRequest(token, sig, url, params);
        } catch (_) {
          validateRequest = null;
        }
      }
      if (!validateRequest) {
        state.log.error(
          { plugin: 'twilio' },
          'inbound webhook requested but twilio.validateRequest is unavailable; route not mounted'
        );
      } else {
        const handler = buildInboundHandler({
          authToken:       state.authToken,
          validateRequest,
          emitter:         inboundEmitter,
          log:             state.log,
          errors:          state.errors,
        });
        const urlencoded = opts.urlencodedParser || defaultUrlencodedParser();
        app.post(config.inboundPath, urlencoded, handler);
        state.log.info(
          { plugin: 'twilio', path: config.inboundPath },
          'davepi-plugin-twilio inbound webhook mounted'
        );
      }
    }
  }

  return {
    name: 'twilio',
    setup,
    sendSms,
    sendWhatsApp,
    onInboundSms,
    verifyTotpForUser,
    inboundEmitter,
    get client() { return state.client; },
    // Test-only / advanced introspection.
    _state: state,
  };
}

const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
module.exports.encrypt = encrypt;
module.exports.decrypt = decrypt;
