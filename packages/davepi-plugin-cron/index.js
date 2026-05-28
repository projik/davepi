'use strict';

/**
 * davepi-plugin-cron
 *
 * Declarative scheduled jobs for dAvePi with Mongo-backed
 * distributed locking. Loaded by listing the package under the
 * consumer project's `package.json -> davepi.plugins`:
 *
 *   {
 *     "davepi": {
 *       "plugins": ["davepi-plugin-cron"],
 *       "cron": {
 *         "nightly-export": { "schedule": "0 2 * * *", "handler": "./jobs/nightly-export.js" },
 *         "reap-pending":   { "schedule": "*\/10 * * * *", "handler": "./jobs/reap-pending.js" }
 *       }
 *     }
 *   }
 *
 * Posture:
 *
 *   - Reads `davepi.cron` from the consumer's package.json and
 *     resolves each `handler` to a module. Programmatic
 *     `register(name, opts)` is also supported for the dynamic-list
 *     case (e.g. one job per active tenant).
 *   - Every scheduled tick goes through `lib/lock.js`, which uses a
 *     unique index on the `cron_lock` collection plus a TTL index
 *     on `expiresAt` for stale-lease sweeping. Two web/worker
 *     processes both wake at the same scheduler tick; exactly one
 *     of them runs the handler.
 *   - Long jobs heartbeat-extend their lease at `leaseSeconds/3`.
 *     If a heartbeat fails (another node has taken over because the
 *     lease was exhausted unnoticed) the handler's AbortSignal
 *     flips so it can stop cooperatively.
 *   - Status route `GET /api/cron` and manual-trigger `POST
 *     /api/cron/:name/run-now` are admin-only. Cron is operator
 *     infrastructure — there's no per-tenant view.
 *   - `NODE_ENV=test` auto-disables the scheduler (mirrors
 *     `middleware/rateLimit.js`). The plugin still loads
 *     registrations and exposes a `tickOnce(name)` helper so tests
 *     can drive a handler synchronously.
 *
 * Why a separate package from davepi-plugin-queue:
 *
 *   The queue plugin (#114) is Redis-backed and exposes BullMQ's
 *   `repeat: { pattern: ... }` for cron-style recurrence. That's
 *   the right answer for projects that ALREADY have Redis.
 *   davepi-plugin-cron uses the existing Mongo connection — zero
 *   new infra — and is the right answer for projects that haven't
 *   added Redis yet. Both can coexist; if you have Redis and want
 *   retries + observability for your scheduled jobs, use the queue
 *   plugin's repeat. If you want minimal-dependency scheduled work,
 *   use this plugin.
 */

const path = require('path');

const lock = require('./lib/lock');
const { loadDeclarativeJobs } = require('./lib/loader');
const { buildRouter } = require('./lib/router');

const ENV_KEYS = {
  enabled:      'CRON_ENABLED',
  statusPath:   'CRON_STATUS_PATH',
  defaultTz:    'CRON_DEFAULT_TZ',
  leaseSeconds: 'CRON_LEASE_SECONDS',
};

const DEFAULTS = {
  statusPath:   '/api/cron',
  defaultTz:    'UTC',
  leaseSeconds: 300,
};

function parseBool(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const v = String(raw).toLowerCase().trim();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return fallback;
}

function parseInt10(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readConfigFromEnv(env) {
  // NODE_ENV=test auto-disables the scheduler unless CRON_ENABLED is
  // explicitly set to true. This matches `middleware/rateLimit.js`'s
  // posture: tests assert handler behaviour, not scheduler timing,
  // and an auto-firing tick would race the test runner.
  const explicitEnabled = env[ENV_KEYS.enabled];
  const isTest = env.NODE_ENV === 'test';
  const enabled = explicitEnabled != null
    ? parseBool(explicitEnabled, true)
    : !isTest;
  return {
    enabled,
    statusPath: env[ENV_KEYS.statusPath] != null
                  ? env[ENV_KEYS.statusPath]
                  : DEFAULTS.statusPath,
    defaultTz:    env[ENV_KEYS.defaultTz] || DEFAULTS.defaultTz,
    leaseSeconds: parseInt10(env[ENV_KEYS.leaseSeconds], DEFAULTS.leaseSeconds),
  };
}

/**
 * Build a fresh plugin instance. Most consumers don't call this
 * directly — `require('davepi-plugin-cron')` returns a default
 * instance configured from `process.env`. Use this factory in tests,
 * or to inject mongoose / express / errors / asyncHandler / croner
 * stubs.
 *
 * Options (all optional):
 *   - env, mongoose, express, errors, asyncHandler — injectables
 *     resolved lazily at setup time via davepi's peerDep otherwise.
 *   - croner: object — a `{ Cron }`-shaped module override. The
 *     real `croner` package is lazy-loaded at setup time so dormant
 *     installs (or unit tests using `tickOnce`) pay no module-graph
 *     cost.
 *   - cwd: string — directory for resolving package.json + handler
 *     specs. Defaults to process.cwd().
 *   - jobs: array — pre-built job list, bypassing the package.json
 *     scan. Useful in tests.
 */
function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const config = readConfigFromEnv(env);
  const injectedMongoose = opts.mongoose || null;
  const injectedExpress = opts.express || null;
  const injectedErrors = opts.errors || null;
  const injectedAuth = opts.auth || null;
  const injectedAsyncHandler = opts.asyncHandler || null;
  const injectedCroner = opts.croner || null;
  const preBuiltJobs = Array.isArray(opts.jobs) ? opts.jobs : null;

  // Per-job state lives in this map keyed by name. We track the
  // schedule, the croner instance (when scheduling is enabled), and
  // the latest run metadata for the status endpoint.
  const jobs = new Map();

  const state = {
    enabled:  false,
    mongoose: null,
    log:      null,
    appName:  'dAvePi',
  };

  function listJobs() {
    return Array.from(jobs.values()).map((j) => ({
      name:           j.name,
      schedule:       j.schedule,
      timezone:       j.timezone,
      leaseSeconds:   j.leaseSeconds,
      nextRun:        j.croner ? j.croner.nextRun() : null,
      lastRun:        j.lastRun,
      lastStatus:     j.lastStatus,
      lastDurationMs: j.lastDurationMs,
      lastError:      j.lastError,
      runCount:       j.runCount,
      failCount:      j.failCount,
    }));
  }

  function getJob(name) {
    return jobs.get(name) || null;
  }

  /**
   * Register a job. Idempotent on `name`: a second register with the
   * same name throws so a misconfiguration (two declarations of the
   * same scheduled task) doesn't silently drop one. Use
   * `unregister(name)` first if you need to replace.
   *
   * Accepts both the declarative shape and the programmatic shape:
   *   register('name', {
   *     schedule:     '0 2 * * *',
   *     handler:      async ({ log, signal, lease, now }) => {...},
   *     timezone:     'America/New_York', // optional
   *     leaseSeconds: 600,                 // optional, default CRON_LEASE_SECONDS
   *   })
   */
  function register(name, jobOpts) {
    if (typeof name !== 'string' || !name.length) {
      throw new TypeError('davepi-plugin-cron: register(name, opts) requires a non-empty string name');
    }
    if (!jobOpts || typeof jobOpts !== 'object') {
      throw new TypeError('davepi-plugin-cron: register(name, opts) requires an opts object');
    }
    if (typeof jobOpts.schedule !== 'string' || !jobOpts.schedule.length) {
      throw new TypeError(`davepi-plugin-cron: register('${name}') requires a string schedule`);
    }
    if (typeof jobOpts.handler !== 'function') {
      throw new TypeError(`davepi-plugin-cron: register('${name}') requires a function handler`);
    }
    if (jobs.has(name)) {
      throw new Error(`davepi-plugin-cron: a job named '${name}' is already registered`);
    }
    const entry = {
      name,
      schedule:     jobOpts.schedule,
      handler:      jobOpts.handler,
      timezone:     jobOpts.timezone || null,
      leaseSeconds: parseInt10(jobOpts.leaseSeconds, config.leaseSeconds),
      croner:       null,
      lastRun:        null,
      lastStatus:     null,
      lastDurationMs: null,
      lastError:      null,
      runCount:       0,
      failCount:      0,
    };
    jobs.set(name, entry);
    // If setup() has already run, schedule immediately.
    if (state.enabled && config.enabled) {
      scheduleJob(entry).catch((err) => {
        state.log && state.log.error(
          { err, plugin: 'cron', name },
          'failed to schedule newly-registered job',
        );
      });
    }
    return entry;
  }

  function unregister(name) {
    const entry = jobs.get(name);
    if (!entry) return false;
    if (entry.croner && typeof entry.croner.stop === 'function') {
      try { entry.croner.stop(); } catch (_) { /* ignore */ }
    }
    jobs.delete(name);
    return true;
  }

  // Resolve croner lazily so tests that never schedule (only call
  // tickOnce) don't have to install the dep.
  function resolveCroner(log) {
    if (injectedCroner) return injectedCroner;
    try {
      return require('croner');
    } catch (err) {
      log.error(
        { err, plugin: 'cron' },
        "could not require 'croner'; scheduling will not run (tickOnce still works)",
      );
      return null;
    }
  }

  async function scheduleJob(entry) {
    const cronerMod = resolveCroner(state.log);
    if (!cronerMod) return;
    const Cron = cronerMod.Cron || cronerMod.default || cronerMod;
    const opts = { protect: true, paused: false };
    if (entry.timezone || config.defaultTz) {
      opts.timezone = entry.timezone || config.defaultTz;
    }
    // croner's protect=true blocks overlapping ticks in the same
    // process; the Mongo lock blocks overlap across processes. Both
    // matter — protect alone is a per-process guard.
    entry.croner = new Cron(entry.schedule, opts, () => {
      runJob(entry, { manual: false }).catch((err) => {
        state.log && state.log.error(
          { err, plugin: 'cron', name: entry.name },
          'cron tick failed',
        );
      });
    });
  }

  /**
   * Acquire the lease for a job. Returns the lease on success, or
   * `null` if another node holds it. Split out from `runJob` so the
   * HTTP run-now endpoint can report the REAL acquisition result
   * (instead of peek-release-reacquire, which races: another node
   * could win the lock between the peek's release and runJob's
   * re-acquire).
   */
  async function acquireLease(entry) {
    if (!state.mongoose) {
      throw new Error('davepi-plugin-cron: cannot run job without a mongoose connection (setup not run)');
    }
    return lock.acquire({
      mongoose:     state.mongoose,
      name:         entry.name,
      leaseSeconds: entry.leaseSeconds,
    });
  }

  /**
   * Run a job with an already-acquired lease. Owns the heartbeat
   * lifecycle, the abort-status detection, and the lease release in
   * the finally block. Returns `{ status, durationMs }`.
   *
   * Abort semantics: the handler is documented to return early when
   * `signal.aborted` is true (cooperative pattern from the README).
   * If we see the signal flipped after a clean return we record the
   * run as `aborted` rather than `ok` — otherwise the lost-lease
   * case is invisible in the status endpoint.
   *
   * Heartbeat: a recursive setTimeout drives the next tick AFTER the
   * previous heartbeat resolves, so a slow Mongo can't stack
   * overlapping calls. `inFlight` is the per-iteration guard; even
   * if the timer fires while we're still mid-call we'd skip
   * — but the recursive shape makes that impossible by construction.
   */
  async function executeWithLease(entry, lease, { manual = false } = {}) {
    const startedAt = Date.now();
    entry.lastRun = startedAt;

    const heartbeatMs = Math.max(1000, Math.floor(entry.leaseSeconds * 1000 / 3));
    let heartbeatTimer = null;
    let heartbeatStopped = false;
    let consecutiveFailures = 0;

    function scheduleHeartbeat() {
      if (heartbeatStopped) return;
      heartbeatTimer = setTimeout(async () => {
        if (heartbeatStopped) return;
        try {
          const ok = await lease.heartbeat();
          if (!ok) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= 2) {
              // lease.heartbeat() already flipped the abort signal
              // when it returned false; we just stop pinging.
              heartbeatStopped = true;
              return;
            }
          } else {
            consecutiveFailures = 0;
          }
        } catch (err) {
          state.log && state.log.warn(
            { err, plugin: 'cron', name: entry.name },
            'heartbeat threw',
          );
        }
        scheduleHeartbeat();
      }, heartbeatMs);
      if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
      }
    }
    if (heartbeatMs < entry.leaseSeconds * 1000) scheduleHeartbeat();

    let status = 'ok';
    let lastError = null;
    try {
      await entry.handler({
        log:    state.log,
        lease,
        signal: lease.signal,
        now:    new Date(startedAt),
        name:   entry.name,
      });
      // Cooperative-abort case: handler returned cleanly but the
      // lease was lost mid-run. Record as aborted so the status
      // endpoint shows the lease event.
      if (lease.signal && lease.signal.aborted) {
        status = 'aborted';
        lastError = 'lease lost mid-run';
      }
    } catch (err) {
      status = lease.signal && lease.signal.aborted ? 'aborted' : 'failed';
      lastError = err && err.message ? err.message : String(err);
      state.log && state.log.error(
        { err, plugin: 'cron', name: entry.name, manual },
        'cron handler threw',
      );
    } finally {
      heartbeatStopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      await lease.release();
    }
    const durationMs = Date.now() - startedAt;
    entry.lastDurationMs = durationMs;
    entry.lastStatus = status;
    entry.lastError = lastError;
    entry.runCount += 1;
    if (status !== 'ok') entry.failCount += 1;
    return { status, durationMs };
  }

  /**
   * Acquire + execute in one call. Returns an outcome object:
   *
   *   { acquired: true,  status: 'ok' | 'failed' | 'aborted', durationMs }
   *   { acquired: false }   // another holder owns it
   */
  async function runJob(entry, { manual = false } = {}) {
    const lease = await acquireLease(entry);
    if (!lease) {
      state.log && state.log.debug && state.log.debug(
        { plugin: 'cron', name: entry.name, manual },
        'tick skipped: lock held by another holder',
      );
      return { acquired: false };
    }
    const result = await executeWithLease(entry, lease, { manual });
    return { acquired: true, ...result };
  }

  /**
   * Public test helper: drive one tick of `name` synchronously
   * regardless of `CRON_ENABLED` / NODE_ENV. Tests assert handler
   * behaviour by calling this and then inspecting side effects;
   * scheduling is the framework's concern, not the test's.
   */
  async function tickOnce(name) {
    const entry = jobs.get(name);
    if (!entry) throw new Error(`davepi-plugin-cron: no job '${name}' registered`);
    return runJob(entry, { manual: true });
  }

  async function setup({ app, schemaLoader, bus, log, appName }) {
    state.log = log;
    state.appName = appName || state.appName;

    let mongoose = injectedMongoose;
    if (!mongoose) {
      try {
        mongoose = require('mongoose');
      } catch (err) {
        log.error(
          { err, plugin: 'cron' },
          "could not require 'mongoose'; davepi-plugin-cron will stay dormant",
        );
        return;
      }
    }
    state.mongoose = mongoose;

    // Indexes are required for the unique-name race and the TTL
    // sweep. The framework's bootstrap doesn't await Mongo
    // connection before loading plugins, so on a cold start we may
    // hit setup() before mongoose is open — bailing here would
    // prevent registration entirely. Instead: try once now, and if
    // the connection isn't ready, register a once-only 'connected'
    // listener so the indexes land as soon as Mongo is up. The
    // `acquire()` path also lazily ensures on first use, closing
    // the gap where the listener never fires (offline test envs,
    // mocked mongoose).
    async function tryEnsureIndexes(context) {
      try {
        await lock.ensureIndexes(mongoose);
        log.info({ plugin: 'cron', when: context }, 'cron_lock indexes ensured');
      } catch (err) {
        log.warn(
          { err, plugin: 'cron', when: context },
          'failed to ensure cron_lock indexes; first tick will retry via acquire()',
        );
      }
    }
    const conn = mongoose.connection;
    const ready = conn && (conn.readyState === 1 || (conn.db && typeof conn.db.collection === 'function'));
    if (ready) {
      await tryEnsureIndexes('setup');
    } else if (conn && typeof conn.once === 'function') {
      log.info(
        { plugin: 'cron' },
        'mongo not yet connected at cron setup; deferring index ensure to the connected event',
      );
      conn.once('connected', () => {
        tryEnsureIndexes('connected-event').catch(() => { /* tryEnsureIndexes already logs */ });
      });
      // 'open' fires after the initial sync; covers older mongoose
      // versions where 'connected' is the wire-up but 'open' is when
      // collections are actually queryable.
      conn.once('open', () => {
        tryEnsureIndexes('open-event').catch(() => { /* logged */ });
      });
    } else {
      // No `once`-style API and not ready — likely a test stub. The
      // first acquire() will lazily ensure indexes.
      log.info(
        { plugin: 'cron' },
        'mongo connection has no once() API; index ensure will run on first acquire()',
      );
    }

    // Load declarative jobs from package.json. If a pre-built jobs
    // array was injected (test path), skip the file scan.
    const declarative = preBuiltJobs || loadDeclarativeJobs({ cwd, log });
    for (const decl of declarative) {
      register(decl.name, decl);
    }

    state.enabled = true;

    // Schedule everything that's already registered. New registers
    // after this point schedule immediately via `register()` itself.
    if (config.enabled) {
      for (const entry of jobs.values()) {
        try {
          await scheduleJob(entry);
        } catch (err) {
          log.error(
            { err, plugin: 'cron', name: entry.name },
            'failed to schedule job at setup',
          );
        }
      }
      log.info(
        { plugin: 'cron', count: jobs.size },
        'davepi-plugin-cron scheduled',
      );
    } else {
      log.info(
        { plugin: 'cron' },
        'davepi-plugin-cron registered but scheduling is disabled (CRON_ENABLED=false or NODE_ENV=test)',
      );
    }

    // Status route is opt-in via CRON_STATUS_PATH; '' disables.
    if (app && config.statusPath) {
      let express = injectedExpress;
      if (!express) {
        try { express = require('express'); } catch (_) {
          log.error({ plugin: 'cron' }, "could not require 'express' for status route; skipping");
        }
      }
      let errors = injectedErrors;
      if (express && !errors) {
        try { errors = require('davepi/utils/errors'); }
        catch (err) {
          log.error({ err, plugin: 'cron' }, "could not require 'davepi/utils/errors'; skipping status route");
        }
      }
      let authFactory = injectedAuth;
      if (express && errors && !authFactory) {
        try { authFactory = require('davepi/middleware/auth'); }
        catch (err) {
          log.error({ err, plugin: 'cron' }, "could not require 'davepi/middleware/auth'; skipping status route");
        }
      }
      let asyncHandler = injectedAsyncHandler;
      if (express && errors && authFactory && !asyncHandler) {
        try { asyncHandler = require('davepi/utils/asyncHandler'); }
        catch (err) {
          log.error({ err, plugin: 'cron' }, "could not require 'davepi/utils/asyncHandler'; skipping status route");
        }
      }
      if (express && errors && authFactory && asyncHandler && typeof app.use === 'function') {
        const router = buildRouter({
          express,
          errors,
          asyncHandler,
          log,
          jobs:   { list: listJobs, get: getJob },
          runNow: async (name) => {
            const entry = jobs.get(name);
            if (!entry) throw new Error(`unknown job '${name}'`);
            // Acquire ONCE and hand the lease into the background
            // executor. The previous peek/release/reacquire shape
            // was racy: another node could win the lock between
            // release and re-acquire, and the HTTP response would
            // claim `acquired:true` while the background runJob
            // returned `acquired:false` and skipped silently.
            const lease = await acquireLease(entry);
            if (!lease) return { acquired: false, reason: 'locked' };
            // Run with the held lease in the background — handler
            // errors are routed through executeWithLease's
            // try/catch + the framework log.
            executeWithLease(entry, lease, { manual: true }).catch((err) => {
              log.error({ err, plugin: 'cron', name }, 'manual run threw');
            });
            return { acquired: true };
          },
        });
        app.use(config.statusPath, authFactory(true), router);
        log.info({ plugin: 'cron', path: config.statusPath }, 'cron status route mounted');
      }
    }

    // Graceful shutdown: stop all croner instances + best-effort
    // release any leases this process holds. BullMQ's queue plugin
    // already registers SIGTERM/SIGINT listeners; we add our own
    // without expecting coordination — running both is harmless.
    const shutdown = async () => {
      for (const entry of jobs.values()) {
        if (entry.croner && typeof entry.croner.stop === 'function') {
          try { entry.croner.stop(); } catch (_) { /* ignore */ }
        }
      }
    };
    state.shutdown = shutdown;
    if (typeof process !== 'undefined' && process.once) {
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    }
  }

  return {
    name: 'cron',
    setup,
    register,
    unregister,
    tickOnce,
    list: listJobs,
    get:  getJob,
    isEnabled: () => state.enabled,
    // Exposed for advanced use (e.g. health checks that want to
    // know the next firing without going through the HTTP status
    // route).
    _config: config,
  };
}

const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
module.exports.COLLECTION = lock.COLLECTION;
