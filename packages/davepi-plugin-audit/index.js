'use strict';

/**
 * davepi-plugin-audit
 *
 * Immutable, append-only audit log for dAvePi. Loaded by listing the
 * package under the consumer project's `package.json -> davepi.plugins`:
 *
 *   {
 *     "davepi": { "plugins": ["davepi-plugin-audit"] }
 *   }
 *
 * Behaviour:
 *   - On boot, auto-registers an `audit` schema (one per process) and
 *     subscribes to the in-process `record` event bus. Every CRUD
 *     event lands as one document in the `audit` collection with
 *     `userId`, `accountId?`, `action`, `resource`, `resourceId`,
 *     `before`, `after`, `diff` (a JSON-Patch from before to after),
 *     `filter` / `numAffected` for bulk events, plus request metadata
 *     (`ip`, `userAgent`, `reqId`) when the producing event carried a
 *     `req` snapshot.
 *   - The `audit` collection is read-only via the standard API:
 *     every field declares an ACL that no role overlaps, and the
 *     schema declares `beforeCreate` / `beforeUpdate` / `beforeDelete`
 *     hooks that throw `ForbiddenError`. The plugin itself writes
 *     directly through Mongoose, which doesn't go through hooks.
 *   - `acl.list = ['admin']` gives admins a cross-tenant view; regular
 *     users see only audit rows for actions they performed (the
 *     standard tenant invariant).
 *   - Retention via TTL index on `at`, controlled by
 *     `AUDIT_RETENTION_DAYS` (default 365; `0` keeps forever and drops
 *     any existing TTL index).
 *
 * Failure isolation: the bus subscriber wraps every Mongo write in
 * try/catch and logs through the framework's pino instance handed in
 * at setup. A misbehaving Mongo or a transient connection blip
 * never blocks the request loop or surfaces as an unhandled
 * rejection — same posture as the slack / postmark plugins.
 *
 * Storage growth: every mutation lands one row carrying `before` +
 * `after` snapshots. Schemas with many large fields and many writes
 * fill Mongo fast — the TTL index is the safety valve. The README
 * carries the sizing math.
 */

const { compare } = require('./lib/diff');
const { redact } = require('./lib/redact');
const { buildAuditSchema } = require('./lib/schema');
const {
  shouldAuditResource,
  parseEventType,
  parseList,
} = require('./lib/matcher');

const ENV_KEYS = {
  enabled:       'AUDIT_ENABLED',
  retentionDays: 'AUDIT_RETENTION_DAYS',
  bulkBypass:    'AUDIT_BULK_BYPASS',
  include:       'AUDIT_INCLUDE',
  exclude:       'AUDIT_EXCLUDE',
  redact:        'AUDIT_REDACT',
};

const DEFAULT_REDACT_FIELDS = ['password', 'token', 'secret'];
const DEFAULT_RETENTION_DAYS = 365;
const TTL_INDEX_NAME = 'audit_at_ttl';
// The plugin's own collection. Events whose resource matches this are
// short-circuited so an audit-of-the-audit-log isn't possible — that
// would only fire if the plugin's own writes somehow re-entered the
// bus (they don't today, but the guard makes the contract explicit).
const SELF_RESOURCE = 'audit';

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseRetentionDays(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return n;
}

function readConfigFromEnv(env) {
  return {
    enabled:       parseBool(env[ENV_KEYS.enabled], true),
    retentionDays: parseRetentionDays(env[ENV_KEYS.retentionDays]),
    bulkBypass:    parseBool(env[ENV_KEYS.bulkBypass], false),
    include:       parseList(env[ENV_KEYS.include]),
    exclude:       parseList(env[ENV_KEYS.exclude]),
    redact:        env[ENV_KEYS.redact] === undefined
      ? DEFAULT_REDACT_FIELDS
      : parseList(env[ENV_KEYS.redact]),
  };
}

/**
 * Build a fresh plugin instance. Most consumers don't call this
 * directly — `require('davepi-plugin-audit')` returns a default
 * instance configured from `process.env`. Use this factory in tests
 * (so you can inject `env`, `mongoose`, and `errors` stubs without a
 * live framework install) or to override the schema version.
 */
function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const injectedMongoose = opts.mongoose || null;
  const injectedErrors = opts.errors || null;
  const schemaVersion = opts.schemaVersion || 'v1';
  const config = readConfigFromEnv(env);

  const state = {
    enabled: false,
    AuditModel: null,
    log: null,
  };

  /**
   * Hand-fire a write into the audit collection. Exposed so consumer
   * code (or a hook) can record a non-CRUD event — "user manually
   * approved waiver", "background job ran" — through the same surface.
   * Best-effort: errors are logged and swallowed, mirroring the bus
   * subscriber's posture.
   */
  async function record(entry) {
    if (!state.enabled || !state.AuditModel) {
      // No-throw on the public API — callers from `after*` hooks
      // shouldn't have to gate on whether the plugin happened to be
      // configured. The slack/postmark plugins DO throw on dormant
      // `postMessage` / `sendEmail` because those are explicit
      // outbound calls; here, "audit a thing" is meant to be
      // ergonomic. A dormant plugin just no-ops.
      return false;
    }
    try {
      await state.AuditModel.create(buildRow(entry));
      return true;
    } catch (err) {
      state.log.error(
        { err, plugin: 'audit' },
        'davepi-plugin-audit: manual record() failed'
      );
      return false;
    }
  }

  function buildRow(input) {
    const now = input && input.at ? new Date(input.at) : new Date();
    const before = redact(input.before == null ? null : input.before, config.redact);
    const after = redact(input.after == null ? null : input.after, config.redact);
    return {
      userId:      input.userId ? String(input.userId) : null,
      accountId:   input.accountId ? String(input.accountId) : null,
      action:      input.action || null,
      resource:    input.resource || null,
      resourceId:  input.resourceId ? String(input.resourceId) : null,
      before,
      after,
      diff:        compare(before, after),
      filter:      input.filter || null,
      numAffected: typeof input.numAffected === 'number' ? input.numAffected : null,
      ip:          input.ip || null,
      userAgent:   input.userAgent || null,
      reqId:       input.reqId || null,
      at:          now,
    };
  }

  /**
   * Translate one bus event into the audit row arguments. Returns
   * `null` to indicate the event should be skipped (resource is the
   * plugin's own collection, type is malformed, or the resource fell
   * out of the include/exclude policy).
   */
  function buildRowFromEvent(event) {
    if (!event || !event.type) return null;
    const parsed = parseEventType(event.type);
    if (!parsed) return null;
    const { resource, action } = parsed;
    if (resource === SELF_RESOURCE) return null;
    if (!shouldAuditResource(resource, config)) return null;
    const isBulk = typeof event.numAffected === 'number' && !event.recordId;
    if (isBulk && config.bulkBypass) return null;

    // For bulk events we lose `before` / `after` per the framework's
    // event contract — emit a single row with the filter + count.
    // Single-record events carry `record` (after), and the framework's
    // REST layer also carries `before` for updates/deletes when
    // available. Some producers (GraphQL, MCP) don't carry `before`
    // yet — those rows show `before: null`, and the diff is the
    // equivalent of "every field added at this snapshot".
    const reqMeta = event.req && typeof event.req === 'object' ? event.req : null;
    if (isBulk) {
      return {
        userId:      event.userId,
        accountId:   event.accountId,
        action,
        resource,
        resourceId:  null,
        before:      null,
        after:       null,
        filter:      event.filter || null,
        numAffected: event.numAffected,
        ip:          reqMeta && reqMeta.ip,
        userAgent:   reqMeta && reqMeta.userAgent,
        reqId:       reqMeta && reqMeta.reqId,
      };
    }
    return {
      userId:     event.userId,
      accountId:  event.accountId || (event.record && event.record.accountId),
      action,
      resource,
      resourceId: event.recordId,
      before:     event.before === undefined ? null : event.before,
      // `record` is the standard payload key from the framework's
      // single-record events; `after` is the (newer) explicit name.
      // Prefer `after` when both are set so a producer can opt into
      // the explicit shape without breaking older consumers.
      after:      event.after !== undefined
        ? event.after
        : (event.record !== undefined ? event.record : null),
      ip:         reqMeta && reqMeta.ip,
      userAgent:  reqMeta && reqMeta.userAgent,
      reqId:      reqMeta && reqMeta.reqId,
    };
  }

  async function ensureTtlIndex(collection) {
    // `0` (or any non-positive) disables retention. We try to drop an
    // existing TTL index if present so flipping the env from "365 →
    // 0" actually frees the index. dropIndex throws when the index
    // doesn't exist; that's fine — we want the no-op path to be
    // silent.
    if (config.retentionDays <= 0) {
      try {
        await collection.dropIndex(TTL_INDEX_NAME);
      } catch (_e) {
        // not present — nothing to drop
      }
      return;
    }
    const seconds = config.retentionDays * 86400;
    try {
      const existing = await collection.indexes();
      const ttl = existing.find((idx) => idx.name === TTL_INDEX_NAME);
      if (ttl && ttl.expireAfterSeconds !== seconds) {
        // Mongo allows modifying TTL via collMod, but dropping and
        // recreating is simpler and the plugin's setup runs once per
        // process anyway. The brief window without a TTL index can't
        // grow the collection meaningfully.
        await collection.dropIndex(TTL_INDEX_NAME);
      }
      if (!ttl || ttl.expireAfterSeconds !== seconds) {
        await collection.createIndex(
          { at: 1 },
          { name: TTL_INDEX_NAME, expireAfterSeconds: seconds }
        );
      }
    } catch (err) {
      state.log.warn(
        { err, plugin: 'audit' },
        'davepi-plugin-audit: TTL index management failed; continuing without TTL'
      );
    }
  }

  async function setup({ app, schemaLoader, bus, log, appName }) {
    state.log = log;

    if (!config.enabled) {
      log.warn(
        { plugin: 'audit' },
        'AUDIT_ENABLED=false; davepi-plugin-audit is dormant'
      );
      return;
    }
    if (!schemaLoader || typeof schemaLoader.loadSchema !== 'function') {
      log.error(
        { plugin: 'audit' },
        'davepi-plugin-audit setup({ schemaLoader }) is required; staying dormant'
      );
      return;
    }
    if (!bus || typeof bus.on !== 'function') {
      log.error(
        { plugin: 'audit' },
        'davepi-plugin-audit setup({ bus }) is required; staying dormant'
      );
      return;
    }

    // Resolve framework dependencies lazily so the package's own unit
    // tests (which don't install `davepi` or any of its deps) can run
    // standalone. Production callers will have these on the require
    // path because the framework itself uses them.
    let mongoose = injectedMongoose;
    if (!mongoose) {
      try {
        mongoose = require('mongoose');
      } catch (err) {
        log.error(
          { err, plugin: 'audit' },
          "could not require 'mongoose' to register audit schema; staying dormant"
        );
        return;
      }
    }
    let errors = injectedErrors;
    if (!errors) {
      try {
        errors = require('davepi/utils/errors');
      } catch (err) {
        log.error(
          { err, plugin: 'audit' },
          "could not require 'davepi/utils/errors' to define audit schema hooks; staying dormant"
        );
        return;
      }
    }

    // Register the audit schema. The loader hot-mounts it onto the
    // existing Express app and rebuilds the GraphQL surface — exactly
    // what the consumer would have done by dropping a file under
    // schema/versions/v1/, just without requiring them to.
    const schema = buildAuditSchema({ mongoose, version: schemaVersion, errors });
    try {
      await schemaLoader.loadSchema(schema);
    } catch (err) {
      log.error(
        { err, plugin: 'audit' },
        'davepi-plugin-audit: failed to register audit schema; staying dormant'
      );
      return;
    }
    const entry = schemaLoader.getEntry(`${schemaVersion}/audit`);
    if (!entry || !entry.model) {
      log.error(
        { plugin: 'audit' },
        'davepi-plugin-audit: audit schema registered but model is missing; staying dormant'
      );
      return;
    }
    state.AuditModel = entry.model;

    // TTL index. Best-effort: if Mongo isn't reachable yet we log and
    // continue — the next setup-cycle (or operator's manual
    // `collection.createIndex(...)`) will catch up.
    if (
      state.AuditModel.collection &&
      typeof state.AuditModel.collection.createIndex === 'function'
    ) {
      await ensureTtlIndex(state.AuditModel.collection);
    }

    state.enabled = true;

    bus.on('record', async (event) => {
      if (!state.enabled || !state.AuditModel) return;
      let row;
      try {
        row = buildRowFromEvent(event);
      } catch (err) {
        // Defensive: a malformed event shouldn't take down the bus
        // listener. Log and move on.
        log.error(
          { err, plugin: 'audit', eventType: event && event.type },
          'davepi-plugin-audit: row build failed'
        );
        return;
      }
      if (!row) return;
      try {
        await state.AuditModel.create(buildRow(row));
      } catch (err) {
        log.error(
          { err, plugin: 'audit', eventType: event && event.type },
          'davepi-plugin-audit: write failed (audit row lost)'
        );
      }
    });

    log.info(
      {
        plugin: 'audit',
        retentionDays: config.retentionDays,
        include:       config.include,
        exclude:       config.exclude,
        bulkBypass:    config.bulkBypass,
      },
      'davepi-plugin-audit ready'
    );
    // Reference `appName` so a future formatter can use it (parity
    // with the slack/postmark plugin signatures); kept here so the
    // contract documented in pluginLoader stays exercised.
    void appName;
    void app;
  }

  return {
    name: 'audit',
    setup,
    record,
    // Exposed for tests + ad-hoc debugging — not part of the
    // documented plugin API but harmless to leave on the object.
    _buildRowFromEvent: buildRowFromEvent,
    _buildRow: buildRow,
    _config: config,
  };
}

const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
module.exports.compare = compare;
module.exports.redact = redact;
