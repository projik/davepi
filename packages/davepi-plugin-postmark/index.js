'use strict';

/**
 * davepi-plugin-postmark
 *
 * Transactional email for dAvePi via Postmark's REST API. Loaded by
 * listing the package under the consumer project's
 * `package.json -> davepi.plugins`:
 *
 *   {
 *     "davepi": { "plugins": ["davepi-plugin-postmark"] }
 *   }
 *
 * Behaviour:
 *   - On boot, reads config from env vars.
 *   - If POSTMARK_SERVER_TOKEN is unset, the plugin is dormant (logs
 *     a warning and exits setup). Calls to `sendEmail` /
 *     `sendTemplate` will throw — useful for tests that assert
 *     "Postmark is wired but stubbed."
 *   - Exposes `sendEmail`, `sendTemplate`, `sendBatch`, and
 *     `sendBatchTemplates` so a schema lifecycle hook
 *     (afterCreate / afterUpdate / etc.) can fire transactional mail
 *     inline. The primary API is the hook-driven path.
 *   - If `createPlugin({ rules: [...] })` is used, the plugin also
 *     subscribes to the in-process record event bus and fires a
 *     template for every matching event. Pure-env auto-send is
 *     intentionally not supported: emails need a recipient and a
 *     template, both of which usually depend on the record's fields,
 *     so the rule has to be code, not env.
 *
 * Failure isolation: the bus subscriber wraps each send in
 * try/catch and logs via the framework logger passed in at setup. A
 * Postmark outage never crashes the request loop. Ad-hoc
 * `sendEmail` / `sendTemplate` calls propagate errors — the caller
 * decides whether to log-and-swallow (the convention in `after*`
 * hooks) or surface to the user.
 */

const { EventEmitter } = require('events');

const { eventMatches } = require('./lib/matcher');
const { post } = require('./lib/post');
const { buildEmailPayload, buildTemplatePayload } = require('./lib/payload');
const { buildInboundHandler } = require('./lib/inbound');

const POSTMARK_BASE_URL = 'https://api.postmarkapp.com';

const ENV_KEYS = {
  serverToken:   'POSTMARK_SERVER_TOKEN',
  from:          'POSTMARK_FROM',
  replyTo:       'POSTMARK_REPLY_TO',
  messageStream: 'POSTMARK_MESSAGE_STREAM',
  appName:       'POSTMARK_APP_NAME',
  inboundPath:   'POSTMARK_INBOUND_PATH',
  inboundAuth:   'POSTMARK_INBOUND_AUTH',
};

function readConfigFromEnv(env) {
  return {
    serverToken:   env[ENV_KEYS.serverToken] || null,
    from:          env[ENV_KEYS.from] || null,
    replyTo:       env[ENV_KEYS.replyTo] || null,
    messageStream: env[ENV_KEYS.messageStream] || null,
    appName:       env[ENV_KEYS.appName] || null,
    inboundPath:   env[ENV_KEYS.inboundPath] || null,
    inboundAuth:   env[ENV_KEYS.inboundAuth] || null,
  };
}

// Loose RFC-5321-ish sanity check: just enough to catch the obvious
// "you put `Acme Co` in POSTMARK_FROM" footgun at boot. We don't try
// to fully validate addresses — that's Postmark's job, and it'll
// return ErrorCode 300 ("Invalid email request") if we send junk.
const FROM_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$|^.+<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/;

/**
 * Build a fresh plugin instance. Most consumers don't call this
 * directly — `require('davepi-plugin-postmark')` returns a default
 * instance configured from `process.env`. Use this factory in tests,
 * or in projects that want to inject a custom fetch / env, or wire
 * event-driven auto-send rules.
 *
 * Options (all optional):
 *   - env:       object — env vars source, defaults to process.env
 *   - fetch:     function — fetch implementation, defaults to global.fetch
 *   - timeoutMs: number — per-request timeout, defaults to 10000
 *   - baseUrl:   string — Postmark API base, defaults to https://api.postmarkapp.com
 *   - rules:     array — event-driven auto-send rules. Each rule is
 *                an object `{ events, build }` where `events` is a
 *                string or array of patterns (see lib/matcher) and
 *                `build(event, { appName })` returns either a
 *                sendTemplate input, or `null` to skip.
 *   - errors:    object — `{ UnauthorizedError, ValidationError }`
 *                framework error constructors used by the inbound
 *                webhook handler. Defaults to a lazy
 *                `require('davepi/utils/errors')` at setup time. The
 *                package's own unit tests inject stubs because they
 *                run without `davepi` installed.
 */
function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = opts.timeoutMs || 10000;
  const baseUrl = (opts.baseUrl || POSTMARK_BASE_URL).replace(/\/+$/, '');
  const rules = Array.isArray(opts.rules) ? opts.rules : [];
  const config = readConfigFromEnv(env);
  const injectedErrors = opts.errors || null;

  // Runtime state captured in a closure so the exported `sendEmail`
  // and the bus subscriber both see the same view. Pre-setup
  // `state.enabled === false` so `sendEmail` throws with a clear
  // message if a hook calls it before boot finishes.
  const state = {
    serverToken:   null,
    from:          null,
    replyTo:       null,
    messageStream: null,
    appName:       'dAvePi',
    enabled:       false,
  };

  // Plugin-local emitter for inbound emails. Kept separate from the
  // framework's `record` bus: inbound mail doesn't share the
  // record-event shape, and subscribers to one shouldn't have to
  // filter out the other. Public API is `onInboundEmail(handler)`;
  // the emitter itself is exposed for advanced cases.
  const inboundEmitter = new EventEmitter();
  inboundEmitter.setMaxListeners(0);

  function onInboundEmail(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('davepi-plugin-postmark: onInboundEmail handler must be a function');
    }
    inboundEmitter.on('email', handler);
    return () => inboundEmitter.off('email', handler);
  }

  function ensureEnabled(call) {
    if (!state.enabled) {
      throw new Error(
        `davepi-plugin-postmark: ${call} called but plugin is dormant ` +
        '(POSTMARK_SERVER_TOKEN not set or setup not run yet)'
      );
    }
  }

  function defaults() {
    return {
      from:          state.from,
      replyTo:       state.replyTo,
      messageStream: state.messageStream,
    };
  }

  async function sendEmail(input) {
    ensureEnabled('sendEmail');
    const payload = buildEmailPayload(input, defaults());
    return post(fetchImpl, `${baseUrl}/email`, payload, {
      serverToken: state.serverToken,
      timeoutMs,
    });
  }

  async function sendTemplate(input) {
    ensureEnabled('sendTemplate');
    const payload = buildTemplatePayload(input, defaults());
    return post(fetchImpl, `${baseUrl}/email/withTemplate`, payload, {
      serverToken: state.serverToken,
      timeoutMs,
    });
  }

  async function sendBatch(inputs) {
    ensureEnabled('sendBatch');
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new Error('davepi-plugin-postmark: sendBatch requires a non-empty array');
    }
    const Messages = inputs.map((m) => buildEmailPayload(m, defaults()));
    return post(fetchImpl, `${baseUrl}/email/batch`, Messages, {
      serverToken: state.serverToken,
      timeoutMs,
    });
  }

  async function sendBatchTemplates(inputs) {
    ensureEnabled('sendBatchTemplates');
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new Error('davepi-plugin-postmark: sendBatchTemplates requires a non-empty array');
    }
    const Messages = inputs.map((m) => buildTemplatePayload(m, defaults()));
    return post(fetchImpl, `${baseUrl}/email/batchWithTemplates`, { Messages }, {
      serverToken: state.serverToken,
      timeoutMs,
    });
  }

  async function setup({ app, schemaLoader, bus, log, appName }) {
    if (!config.serverToken) {
      // Don't crash boot — operators may not have wired Postmark yet,
      // and a missing env var in CI / staging shouldn't be fatal.
      // Dormant mode also keeps `sendEmail` honest: hooks that try to
      // use it without configuration get a clear thrown message
      // pointing at the env var.
      log.warn(
        { plugin: 'postmark' },
        'POSTMARK_SERVER_TOKEN not set; davepi-plugin-postmark is dormant'
      );
      return;
    }
    if (config.from && !FROM_RE.test(config.from)) {
      log.error(
        { plugin: 'postmark', from: config.from },
        'POSTMARK_FROM is not a valid email address; davepi-plugin-postmark will stay dormant'
      );
      return;
    }

    state.serverToken   = config.serverToken;
    state.from          = config.from;
    state.replyTo       = config.replyTo;
    state.messageStream = config.messageStream;
    state.appName       = config.appName || appName || 'dAvePi';
    state.enabled       = true;

    // Inbound webhook: opt-in via env. Both POSTMARK_INBOUND_PATH and
    // POSTMARK_INBOUND_AUTH must be set; an unauthenticated public
    // POST endpoint that fans out to user code is a foot-cannon. If
    // only one is set, log an error and skip — don't silently leave
    // the operator believing inbound is wired.
    if (config.inboundPath || config.inboundAuth) {
      if (!config.inboundPath || !config.inboundAuth) {
        log.error(
          { plugin: 'postmark' },
          'inbound webhook is half-configured (need both POSTMARK_INBOUND_PATH and POSTMARK_INBOUND_AUTH); skipping route'
        );
      } else if (!config.inboundAuth.includes(':')) {
        log.error(
          { plugin: 'postmark' },
          'POSTMARK_INBOUND_AUTH must be "user:pass" basic-auth pair; skipping route'
        );
      } else if (!app || typeof app.post !== 'function') {
        log.error(
          { plugin: 'postmark' },
          'inbound webhook requested but no Express app was provided to setup(); skipping route'
        );
      } else {
        // Resolve the framework's typed error constructors via the
        // peerDep here, not at module load time, so the package's
        // own unit tests (which don't install `davepi`) still load.
        // If the peer dep isn't on the require path at runtime the
        // operator already has a deeper setup problem — log it and
        // refuse to mount the route rather than respond with junk.
        // `createPlugin({ errors })` lets tests inject stubs.
        let errors = injectedErrors;
        if (!errors) {
          try {
            errors = require('davepi/utils/errors');
          } catch (err) {
            log.error(
              { err, plugin: 'postmark' },
              "could not require 'davepi/utils/errors' to mount inbound webhook; skipping route"
            );
          }
        }
        if (errors) {
          const handler = buildInboundHandler({
            auth:    config.inboundAuth,
            emitter: inboundEmitter,
            log,
            errors,
          });
          app.post(config.inboundPath, handler);
          log.info(
            { plugin: 'postmark', path: config.inboundPath },
            'davepi-plugin-postmark inbound webhook mounted'
          );
        }
      }
    }

    if (!rules.length) {
      log.info(
        { plugin: 'postmark' },
        'davepi-plugin-postmark ready (no rules configured; sendEmail / sendTemplate available for manual use)'
      );
      return;
    }

    // Validate rules once, eagerly, so a typo doesn't surface only
    // when the first event fires.
    rules.forEach((rule, i) => {
      if (!rule || typeof rule !== 'object') {
        throw new Error(`davepi-plugin-postmark: rules[${i}] must be an object`);
      }
      const events = Array.isArray(rule.events) ? rule.events : [rule.events];
      if (!events.length || events.some((e) => typeof e !== 'string' || !e)) {
        throw new Error(`davepi-plugin-postmark: rules[${i}].events must be a non-empty string or array of strings`);
      }
      if (typeof rule.build !== 'function') {
        throw new Error(`davepi-plugin-postmark: rules[${i}].build must be a function`);
      }
    });

    bus.on('record', async (event) => {
      if (!event || !event.type) return;
      for (const rule of rules) {
        const patterns = Array.isArray(rule.events) ? rule.events : [rule.events];
        if (!eventMatches(patterns, event.type)) continue;
        try {
          const input = await rule.build(event, { appName: state.appName });
          if (!input) continue; // rule opted to skip this event
          await sendTemplate(input);
        } catch (err) {
          // Best-effort: never let a Postmark failure surface as an
          // unhandledRejection. The framework's pino instance is
          // passed in via `log`, so the error reaches operator logs
          // with the same shape as every other plugin handler.
          log.error(
            { err, plugin: 'postmark', eventType: event.type },
            'davepi-plugin-postmark: rule send failed'
          );
        }
      }
    });

    log.info(
      { plugin: 'postmark', ruleCount: rules.length },
      'davepi-plugin-postmark ready'
    );
  }

  return {
    name: 'postmark',
    setup,
    sendEmail,
    // Postmark's endpoint is `/email/withTemplate`; this is the
    // canonical name. `sendTemplate` is kept as a short alias.
    sendEmailWithTemplate: sendTemplate,
    sendTemplate,
    sendBatch,
    sendBatchTemplates,
    onInboundEmail,
    inboundEmitter,
  };
}

// Default export: a plugin instance backed by process.env. This is
// what `require('davepi-plugin-postmark')` returns, which is what the
// pluginLoader hands to the consumer when they list this package in
// `davepi.plugins`. Additional named exports (`createPlugin`,
// helpers) are attached for tests and advanced consumers.
const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
module.exports.buildEmailPayload = buildEmailPayload;
module.exports.buildTemplatePayload = buildTemplatePayload;
