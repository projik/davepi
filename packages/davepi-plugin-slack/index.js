'use strict';

/**
 * davepi-plugin-slack
 *
 * Slack notifications for dAvePi. Loaded by listing the package
 * under the consumer project's `package.json -> davepi.plugins`:
 *
 *   {
 *     "davepi": { "plugins": ["davepi-plugin-slack"] }
 *   }
 *
 * Behaviour:
 *   - On boot, reads config from env vars.
 *   - If SLACK_WEBHOOK_URL is unset, the plugin is dormant (logs a
 *     warning and exits setup). The consumer can still
 *     `require('davepi-plugin-slack').postMessage(...)` but every
 *     call will throw — useful for tests that assert "Slack is
 *     wired but stubbed."
 *   - If SLACK_EVENTS is set, subscribes to the in-process record
 *     event bus and posts a formatted message for every matching
 *     event.
 *   - In all cases, exports `postMessage(text, extras)` so a
 *     lifecycle hook (afterCreate / afterUpdate / etc.) can fire
 *     a custom message inline.
 *
 * Failure isolation: the bus subscriber wraps each post in
 * try/catch and logs via the framework logger that the plugin
 * loader hands in. A Slack outage never crashes the request loop.
 * Ad-hoc `postMessage` calls propagate errors — the caller decides
 * how to handle them (the docs convention is `try/catch` in the
 * hook).
 */

const { eventMatches } = require('./lib/matcher');
const { post } = require('./lib/post');

const ENV_KEYS = {
  url:       'SLACK_WEBHOOK_URL',
  events:    'SLACK_EVENTS',
  username:  'SLACK_USERNAME',
  iconEmoji: 'SLACK_ICON_EMOJI',
  appName:   'SLACK_APP_NAME',
};

function parseEvents(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function readConfigFromEnv(env) {
  return {
    webhookUrl: env[ENV_KEYS.url] || null,
    events:     parseEvents(env[ENV_KEYS.events]),
    username:   env[ENV_KEYS.username] || null,
    iconEmoji:  env[ENV_KEYS.iconEmoji] || null,
    appName:    env[ENV_KEYS.appName] || null,
  };
}

/**
 * Render a record-event into the Slack `text` payload. Override via
 * `createPlugin({ formatter })` if the default doesn't fit your
 * Slack workspace (e.g. you want block-kit cards instead of mrkdwn).
 *
 * Event shape comes from utils/events.js in the framework:
 *   - Single-record events:   { type, version, userId, recordId, record }
 *   - Bulk events:            { type, version, userId, filter, numAffected }
 *   - Transitioned events:    { type, version, userId, recordId, field, from, to }
 */
function defaultFormatter(event, { appName }) {
  const tag = `*${appName}*`;
  if (event.from !== undefined && event.to !== undefined) {
    return `${tag} — \`${event.type}\` — \`${event.recordId}\` — ${event.field}: ${event.from} → ${event.to}`;
  }
  if (event.recordId) {
    return `${tag} — \`${event.type}\` — \`${event.recordId}\``;
  }
  if (typeof event.numAffected === 'number') {
    return `${tag} — \`${event.type}\` — ${event.numAffected} record(s) affected`;
  }
  return `${tag} — \`${event.type}\``;
}

/**
 * Build a fresh plugin instance. Most consumers don't call this
 * directly — `require('davepi-plugin-slack')` returns a default
 * instance configured from `process.env`. Use this factory in
 * tests, or in projects that want to inject a custom fetch / env /
 * formatter.
 *
 * Options (all optional):
 *   - env:       object — env vars source, defaults to process.env
 *   - fetch:     function — fetch implementation, defaults to global.fetch
 *   - formatter: function(event, { appName }) -> string
 *   - timeoutMs: number — per-post timeout, defaults to 10000
 */
function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const formatter = opts.formatter || defaultFormatter;
  const timeoutMs = opts.timeoutMs || 10000;
  const config = readConfigFromEnv(env);

  // Runtime state is captured into a closure so the exported
  // `postMessage` and the bus subscriber both see the same view.
  // Pre-setup `state.url === null` so `postMessage` throws with a
  // clear message if a hook calls it before boot finishes.
  const state = {
    url:       null,
    username:  null,
    iconEmoji: null,
    appName:   'dAvePi',
    enabled:   false,
  };

  async function postMessage(text, extras = {}) {
    if (!state.enabled) {
      throw new Error(
        'davepi-plugin-slack: postMessage called but plugin is dormant ' +
        '(SLACK_WEBHOOK_URL not set or setup not run yet)'
      );
    }
    const body = { text, ...extras };
    if (state.username && !body.username) body.username = state.username;
    if (state.iconEmoji && !body.icon_emoji) body.icon_emoji = state.iconEmoji;
    return post(fetchImpl, state.url, body, { timeoutMs });
  }

  async function setup({ bus, log, appName }) {
    if (!config.webhookUrl) {
      // Don't crash — operators may not have configured Slack yet,
      // and a missing env var shouldn't fail boot. Dormant mode
      // also lets `postMessage` throw clearly if a hook tries to
      // use it without configuring the webhook.
      log.warn(
        { plugin: 'slack' },
        'SLACK_WEBHOOK_URL not set; davepi-plugin-slack is dormant'
      );
      return;
    }
    // Validate the URL shape early so a typo doesn't surface only
    // when the first event fires.
    let parsed;
    try {
      parsed = new URL(config.webhookUrl);
    } catch (_) {
      log.error(
        { plugin: 'slack' },
        'SLACK_WEBHOOK_URL is not a valid URL; davepi-plugin-slack will stay dormant'
      );
      return;
    }
    if (parsed.protocol !== 'https:') {
      log.error(
        { plugin: 'slack', protocol: parsed.protocol },
        'SLACK_WEBHOOK_URL must be https://; davepi-plugin-slack will stay dormant'
      );
      return;
    }

    state.url       = config.webhookUrl;
    state.username  = config.username;
    state.iconEmoji = config.iconEmoji;
    state.appName   = config.appName || appName || 'dAvePi';
    state.enabled   = true;

    if (!config.events.length) {
      log.info(
        { plugin: 'slack' },
        'davepi-plugin-slack ready (no SLACK_EVENTS configured; postMessage available for manual use)'
      );
      return;
    }

    bus.on('record', async (event) => {
      if (!event || !event.type) return;
      if (!eventMatches(config.events, event.type)) return;
      try {
        const text = formatter(event, { appName: state.appName });
        await postMessage(text);
      } catch (err) {
        // Best-effort: never let a Slack failure surface as an
        // unhandledRejection. The framework's pino instance is
        // passed in via `log`, so the error reaches operator logs
        // with the same shape as every other plugin event handler.
        log.error(
          { err, plugin: 'slack', eventType: event.type },
          'davepi-plugin-slack: post failed'
        );
      }
    });

    log.info(
      { plugin: 'slack', events: config.events },
      'davepi-plugin-slack ready'
    );
  }

  return {
    name: 'slack',
    setup,
    postMessage,
  };
}

// Default export: a plugin instance backed by process.env. This is
// what `require('davepi-plugin-slack')` returns, which is what the
// pluginLoader hands to the consumer when they list this package in
// `davepi.plugins`. Additional named exports (`createPlugin`,
// helpers) are attached for tests and advanced consumers.
const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
module.exports.defaultFormatter = defaultFormatter;
