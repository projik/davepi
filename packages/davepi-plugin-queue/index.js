'use strict';

/**
 * davepi-plugin-queue
 *
 * Durable background jobs for dAvePi via [BullMQ][bullmq]. Loaded by
 * listing the package under the consumer project's
 * `package.json -> davepi.plugins`:
 *
 *   {
 *     "davepi": { "plugins": ["davepi-plugin-queue"] }
 *   }
 *
 * Behaviour:
 *   - On boot, reads config from env vars. If `QUEUE_REDIS_URL` is
 *     unset the plugin is dormant: `enqueue` / `registerJob` throw
 *     with a clear message, no `bus`/queue/worker is attached, no
 *     route is mounted. This keeps the plugin safe to depend on in
 *     projects that haven't wired Redis yet.
 *   - When enabled, owns a single BullMQ `Queue` for enqueueing and
 *     (unless `QUEUE_WORKER=false`) a single `Worker` that fans
 *     incoming jobs out to handlers registered via `registerJob`.
 *   - Subscribes to `bus.on('job:enqueue', ...)` so schema lifecycle
 *     hooks can defer slow work without importing this module
 *     directly — preserves loose coupling between schemas and
 *     plugins.
 *   - Optional `rules: [{ events, build }]` factory option subscribes
 *     to `record:*` events and auto-enqueues a job per matching event
 *     (same shape as davepi-plugin-postmark rules, but the build()
 *     returns `{ name, data, opts }` instead of a Postmark template
 *     input).
 *   - Rebroadcasts BullMQ worker lifecycle as `record`-bus
 *     `job.completed` / `job.failed` events so the audit / slack /
 *     sentry plugins can observe without code changes.
 *   - Opt-in `GET <QUEUE_STATUS_PATH>/:id` status endpoint; tenant
 *     scoped via the userId stamped at enqueue time. The route is
 *     mounted behind the framework's `auth(true)` middleware (looked
 *     up lazily via the peerDep) so a JWT is required.
 *
 * Failure isolation: the bus subscriber and the worker rebroadcaster
 * wrap each operation in try/catch and log through the framework's
 * pino instance passed in at setup. A BullMQ outage never crashes the
 * request loop. Ad-hoc `enqueue` calls propagate errors — the caller
 * decides whether to log-and-swallow (convention in `after*` hooks)
 * or surface to the user.
 *
 * [bullmq]: https://docs.bullmq.io/
 */

const path = require('path');

const { eventMatches } = require('./lib/matcher');
const { buildStatusRouter } = require('./lib/router');

const ENV_KEYS = {
  redisUrl:    'QUEUE_REDIS_URL',
  name:        'QUEUE_NAME',
  concurrency: 'QUEUE_CONCURRENCY',
  worker:      'QUEUE_WORKER',
  prefix:      'QUEUE_PREFIX',
  statusPath:  'QUEUE_STATUS_PATH',
  failedTtl:   'QUEUE_FAILED_TTL',
};

const DEFAULTS = {
  name:        'davepi',
  concurrency: 5,
  worker:      true,
  prefix:      'bull',
  statusPath:  '/api/jobs',
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

// Parse a duration like "7d", "12h", "30m", "60s", or a bare integer
// (interpreted as milliseconds). Used for QUEUE_FAILED_TTL. Returns
// milliseconds or null if unset / unparseable.
function parseDuration(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  const mult = unit === 'd' ? 86400000
             : unit === 'h' ? 3600000
             : unit === 'm' ? 60000
             : unit === 's' ? 1000
             : 1;
  return n * mult;
}

function readConfigFromEnv(env) {
  return {
    redisUrl:    env[ENV_KEYS.redisUrl] || null,
    name:        env[ENV_KEYS.name] || DEFAULTS.name,
    concurrency: parseInt10(env[ENV_KEYS.concurrency], DEFAULTS.concurrency),
    worker:      parseBool(env[ENV_KEYS.worker], DEFAULTS.worker),
    prefix:      env[ENV_KEYS.prefix] || DEFAULTS.prefix,
    // Empty string disables the route. Anything else is the mount path.
    statusPath:  env[ENV_KEYS.statusPath] != null
                   ? env[ENV_KEYS.statusPath]
                   : DEFAULTS.statusPath,
    failedTtlMs: parseDuration(env[ENV_KEYS.failedTtl]),
  };
}

/**
 * Build a fresh plugin instance. Most consumers don't call this
 * directly — `require('davepi-plugin-queue')` returns a default
 * instance configured from `process.env`. Use this factory in tests,
 * or in projects that want to inject a stub BullMQ / env / express /
 * rule list.
 *
 * Options (all optional):
 *   - env:       object — env vars source, defaults to process.env
 *   - bullmq:    object — BullMQ-shaped module override; useful in
 *                tests to inject `{ Queue, Worker, QueueEvents }`
 *                stubs without actually importing bullmq. When
 *                omitted, the real `bullmq` package is lazy-loaded at
 *                setup time so consumers that leave the plugin
 *                dormant don't pay the import cost.
 *   - express:   object — Express override; the consumer's installed
 *                Express is used by default (via peerDep). Tests can
 *                inject `require('express')`.
 *   - errors:    object — `{ NotFoundError, ForbiddenError }`
 *                framework error constructors used by the status
 *                route. Defaults to a lazy
 *                `require('davepi/utils/errors')` at setup time.
 *   - auth:      function — middleware factory matching the
 *                framework's `middleware/auth.js`. Defaults to a lazy
 *                `require('davepi/middleware/auth')`.
 *   - rules:     array — record-event auto-enqueue rules. Each rule
 *                is `{ events, build }` where `events` is a string or
 *                array of patterns and `build(event, { appName })`
 *                returns `{ name, data, opts }` (or `null` to skip).
 */
function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const config = readConfigFromEnv(env);
  const rules = Array.isArray(opts.rules) ? opts.rules : [];
  const injectedBullmq = opts.bullmq || null;
  const injectedExpress = opts.express || null;
  const injectedErrors = opts.errors || null;
  const injectedAuth = opts.auth || null;

  // Registered handlers live in a Map keyed by job name. Filled by
  // `registerJob` calls; the Worker dispatcher below dispatches the
  // job to the matching handler. We accept registrations both before
  // and after `setup` runs (registerJob is commonly called from
  // another plugin's setup — declaration order matters, and an
  // unrelated plugin shouldn't have to care which loaded first).
  const handlers = new Map();

  const state = {
    enabled:    false,
    queue:      null,
    worker:     null,
    queueEvents: null,
    appName:    'dAvePi',
    log:        null,
    bus:        null,
  };

  function ensureEnabled(call) {
    if (!state.enabled) {
      throw new Error(
        `davepi-plugin-queue: ${call} called but plugin is dormant ` +
        '(QUEUE_REDIS_URL not set or setup not run yet)'
      );
    }
  }

  /**
   * Stamp tenancy fields onto job.data so the status endpoint can
   * enforce the multi-tenant invariant. `user` may be the
   * `req.user` object (JWT payload), a `{ user_id, accountId }`
   * object, or null/undefined when the caller is non-HTTP.
   */
  function stampTenancy(data, user) {
    const out = { ...(data || {}) };
    if (user && user.user_id != null && out.userId == null) {
      out.userId = String(user.user_id);
    }
    if (user && user.accountId != null && out.accountId == null) {
      out.accountId = String(user.accountId);
    }
    return out;
  }

  /**
   * Enqueue a job. `opts.user` is the tenancy stamp; pass `req.user`
   * from inside a request handler, or an explicit `{ user_id }` from
   * non-HTTP callers. Throws if no tenancy stamp is supplied AND no
   * userId is already in data — the status endpoint can't enforce
   * tenancy on an unscoped job, so refusing at enqueue time is the
   * safer default.
   *
   * `opts` accepts every BullMQ JobsOptions field plus the davepi
   * `user` extension. Defaults: attempts=3, exponential backoff
   * starting at 2s, removeOnFail honours QUEUE_FAILED_TTL.
   */
  async function enqueue(name, data, opts = {}) {
    ensureEnabled('enqueue');
    if (typeof name !== 'string' || !name.length) {
      throw new TypeError('davepi-plugin-queue: enqueue(name, ...) requires a non-empty string name');
    }
    const { user, ...jobOpts } = opts || {};
    const stamped = stampTenancy(data, user);
    if (stamped.userId == null) {
      throw new Error(
        'davepi-plugin-queue: enqueue requires a userId — pass { user: req.user } ' +
        'in opts, or include userId directly in data. Server-wide jobs without a ' +
        'tenant should pass an explicit { user: { user_id: "system" } }.'
      );
    }
    const finalOpts = {
      attempts: jobOpts.attempts != null ? jobOpts.attempts : 3,
      backoff:  jobOpts.backoff || { type: 'exponential', delay: 2000 },
      ...jobOpts,
    };
    if (finalOpts.removeOnFail == null && config.failedTtlMs != null) {
      finalOpts.removeOnFail = { age: Math.floor(config.failedTtlMs / 1000) };
    }
    return state.queue.add(name, stamped, finalOpts);
  }

  /**
   * Register a handler for a job name. Handlers are dispatched by the
   * single Worker process; concurrency is configured at the Worker
   * level via `QUEUE_CONCURRENCY`. May be called before or after
   * `setup` — handlers registered late still take effect for any
   * job processed thereafter.
   *
   * `repeatOpts` is the BullMQ "repeat" shorthand for cron-style
   * jobs. When supplied, the plugin schedules a recurring job under
   * the same name at setup time (or immediately, if setup has
   * already finished).
   *
   * The handler signature is `async (data, ctx)` where `ctx`
   * contains `{ log, attempt, jobId, name }`. We deliberately don't
   * hand the raw BullMQ `job` to handlers so a future swap of the
   * queue backend doesn't break consumers.
   */
  function registerJob(name, handler, repeatOpts) {
    if (typeof name !== 'string' || !name.length) {
      throw new TypeError('davepi-plugin-queue: registerJob(name, handler) requires a non-empty name');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('davepi-plugin-queue: registerJob(name, handler) requires a function handler');
    }
    if (handlers.has(name)) {
      // Last-write-wins would be surprising; refusing makes
      // double-registration (e.g. two plugins both wiring the same
      // job name) visible at boot rather than silently dropping one.
      throw new Error(`davepi-plugin-queue: a handler for "${name}" is already registered`);
    }
    handlers.set(name, handler);

    if (repeatOpts && repeatOpts.repeat) {
      // BullMQ's repeat option requires the job to be added once;
      // subsequent invocations are scheduled by the queue itself.
      // When setup hasn't run yet, defer the add until it does by
      // stashing on the handler entry.
      const repeatJob = {
        name,
        data: stampTenancy({ __repeat: true }, { user_id: 'system' }),
        opts: { ...repeatOpts, jobId: `repeat:${name}` },
      };
      if (state.enabled && state.queue) {
        state.queue.add(repeatJob.name, repeatJob.data, repeatJob.opts).catch((err) => {
          state.log && state.log.error(
            { err, plugin: 'queue', name },
            'failed to schedule repeating job'
          );
        });
      } else {
        handlers.get(name).__pendingRepeat = repeatJob;
      }
    }
  }

  async function dispatchJob(job, log) {
    const handler = handlers.get(job.name);
    if (!handler) {
      // No handler registered for this job name. A repeat-scheduling
      // marker would otherwise crash the worker; treat unknown jobs
      // as a no-op and log so operators can see the orphan.
      log.warn(
        { plugin: 'queue', name: job.name, jobId: job.id },
        'no handler registered for job; skipping'
      );
      return null;
    }
    const ctx = {
      log,
      // BullMQ increments `attemptsMade` before invoking the
      // processor, so on the first attempt this is already 1.
      attempt: job.attemptsMade != null ? job.attemptsMade : 1,
      jobId:   String(job.id),
      name:    job.name,
    };
    return handler(job.data, ctx);
  }

  function attachRebroadcast(worker, bus, log) {
    if (!worker || !bus) return;
    worker.on('completed', (job, returnvalue) => {
      try {
        bus.emit('record', {
          type:     'job.completed',
          jobId:    job && job.id != null ? String(job.id) : null,
          name:     job && job.name,
          userId:   job && job.data && job.data.userId ? String(job.data.userId) : null,
          attempts: job && job.attemptsMade,
          returnValue: returnvalue,
        });
      } catch (err) {
        log.error({ err, plugin: 'queue' }, 'failed to rebroadcast job.completed');
      }
    });
    worker.on('failed', (job, err) => {
      try {
        bus.emit('record', {
          type:     'job.failed',
          jobId:    job && job.id != null ? String(job.id) : null,
          name:     job && job.name,
          userId:   job && job.data && job.data.userId ? String(job.data.userId) : null,
          attempts: job && job.attemptsMade,
          error:    err && err.message,
        });
      } catch (busErr) {
        log.error({ err: busErr, plugin: 'queue' }, 'failed to rebroadcast job.failed');
      }
    });
    worker.on('stalled', (jobId) => {
      try {
        bus.emit('record', {
          type:  'job.stalled',
          jobId: jobId != null ? String(jobId) : null,
        });
      } catch (err) {
        log.error({ err, plugin: 'queue' }, 'failed to rebroadcast job.stalled');
      }
    });
  }

  async function setup({ app, schemaLoader, bus, log, appName }) {
    state.log = log;
    state.bus = bus;
    state.appName = appName || state.appName;

    if (!config.redisUrl) {
      log.warn(
        { plugin: 'queue' },
        'QUEUE_REDIS_URL not set; davepi-plugin-queue is dormant'
      );
      return;
    }

    // Lazy-load bullmq so dormant installations pay no module-graph
    // cost. The test suite injects a stub via `opts.bullmq`.
    let bullmq = injectedBullmq;
    if (!bullmq) {
      try {
        bullmq = require('bullmq');
      } catch (err) {
        log.error(
          { err, plugin: 'queue' },
          "could not require 'bullmq' (is it installed?); plugin will stay dormant"
        );
        return;
      }
    }
    const { Queue, Worker } = bullmq;
    if (!Queue || !Worker) {
      log.error(
        { plugin: 'queue' },
        'bullmq module is missing Queue/Worker exports; plugin will stay dormant'
      );
      return;
    }

    // BullMQ accepts either a `connection` object or a Redis URL. We
    // hand it the URL plus the minimal `maxRetriesPerRequest: null`
    // that BullMQ requires of ioredis connections used for blocking
    // commands; not setting this surfaces as a confusing warning on
    // the first worker tick.
    const connection = {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
    };

    let queue;
    try {
      queue = new Queue(config.name, { connection, prefix: config.prefix });
    } catch (err) {
      log.error(
        { err, plugin: 'queue' },
        'failed to construct BullMQ Queue; plugin will stay dormant'
      );
      return;
    }
    state.queue = queue;
    state.enabled = true;

    // Bus-driven enqueue: hooks emit `job:enqueue` to defer slow
    // work without importing this module.
    if (bus) {
      bus.on('job:enqueue', async (req) => {
        if (!req || typeof req.name !== 'string') {
          log.warn(
            { plugin: 'queue', req },
            "bus 'job:enqueue' payload missing required `name`; ignoring"
          );
          return;
        }
        try {
          await enqueue(req.name, req.data, req.opts);
        } catch (err) {
          log.error(
            { err, plugin: 'queue', name: req.name },
            "bus 'job:enqueue' failed"
          );
        }
      });
    }

    // Validate rules eagerly so a typo doesn't surface only when the
    // first event fires.
    rules.forEach((rule, i) => {
      if (!rule || typeof rule !== 'object') {
        throw new Error(`davepi-plugin-queue: rules[${i}] must be an object`);
      }
      const events = Array.isArray(rule.events) ? rule.events : [rule.events];
      if (!events.length || events.some((e) => typeof e !== 'string' || !e)) {
        throw new Error(
          `davepi-plugin-queue: rules[${i}].events must be a non-empty string or array of strings`
        );
      }
      if (typeof rule.build !== 'function') {
        throw new Error(`davepi-plugin-queue: rules[${i}].build must be a function`);
      }
    });

    if (rules.length && bus) {
      bus.on('record', async (event) => {
        if (!event || !event.type) return;
        // Don't re-enqueue our own rebroadcasts.
        if (event.type.startsWith('job.')) return;
        for (const rule of rules) {
          const patterns = Array.isArray(rule.events) ? rule.events : [rule.events];
          if (!eventMatches(patterns, event.type)) continue;
          try {
            const built = await rule.build(event, { appName: state.appName });
            if (!built) continue;
            const stampUser = built.user || { user_id: event.userId };
            await enqueue(built.name, built.data, { ...(built.opts || {}), user: stampUser });
          } catch (err) {
            log.error(
              { err, plugin: 'queue', eventType: event.type },
              'davepi-plugin-queue: rule enqueue failed'
            );
          }
        }
      });
    }

    // Worker boot. `QUEUE_WORKER=false` is the documented escape
    // hatch for splitting web and worker dynos; in that mode this
    // process only enqueues and the status route only reads metadata
    // from BullMQ — actual processing happens in a separate dyno
    // that boots the same plugin with worker=true.
    if (config.worker) {
      try {
        const worker = new Worker(
          config.name,
          async (job) => dispatchJob(job, log),
          { connection, prefix: config.prefix, concurrency: config.concurrency }
        );
        state.worker = worker;
        attachRebroadcast(worker, bus, log);
      } catch (err) {
        log.error(
          { err, plugin: 'queue' },
          'failed to construct BullMQ Worker; enqueue will still work but jobs will not be processed'
        );
      }
    }

    // Flush any repeating jobs that were declared via registerJob
    // before setup ran.
    for (const [name, handler] of handlers.entries()) {
      if (handler.__pendingRepeat) {
        const pending = handler.__pendingRepeat;
        delete handler.__pendingRepeat;
        try {
          await state.queue.add(pending.name, pending.data, pending.opts);
        } catch (err) {
          log.error(
            { err, plugin: 'queue', name },
            'failed to schedule pending repeating job'
          );
        }
      }
    }

    // Status route is opt-in. Empty string for QUEUE_STATUS_PATH
    // disables it.
    if (app && config.statusPath) {
      let express = injectedExpress;
      if (!express) {
        try {
          express = require('express');
        } catch (_) {
          // Consumer must have express installed; if we can't load
          // it, log and skip the route.
          log.error(
            { plugin: 'queue' },
            "could not require 'express' for status route; skipping"
          );
        }
      }
      let errors = injectedErrors;
      if (express && !errors) {
        try {
          errors = require('davepi/utils/errors');
        } catch (err) {
          log.error(
            { err, plugin: 'queue' },
            "could not require 'davepi/utils/errors' for status route; skipping"
          );
        }
      }
      let authFactory = injectedAuth;
      if (express && errors && !authFactory) {
        try {
          authFactory = require('davepi/middleware/auth');
        } catch (err) {
          log.error(
            { err, plugin: 'queue' },
            "could not require 'davepi/middleware/auth' for status route; skipping"
          );
        }
      }
      if (express && errors && authFactory && typeof app.use === 'function') {
        const router = buildStatusRouter({
          express,
          getQueue: () => state.queue,
          errors,
          log,
        });
        app.use(config.statusPath, authFactory(true), router);
        log.info(
          { plugin: 'queue', path: config.statusPath },
          'davepi-plugin-queue status route mounted'
        );
      }
    }

    // Graceful shutdown: drain in-flight jobs on SIGTERM/SIGINT. The
    // framework's lifecycle (utils/lifecycle) is in charge of the
    // process; we register listeners that BullMQ documents as
    // shutdown-safe and let the existing signal handlers fire ours
    // too.
    const shutdown = async () => {
      try {
        if (state.worker) await state.worker.close();
        if (state.queue) await state.queue.close();
      } catch (err) {
        log.error({ err, plugin: 'queue' }, 'queue shutdown failed');
      }
    };
    state.shutdown = shutdown;
    if (typeof process !== 'undefined' && process.once) {
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    }

    log.info(
      {
        plugin: 'queue',
        name:        config.name,
        concurrency: config.concurrency,
        worker:      config.worker,
        prefix:      config.prefix,
        ruleCount:   rules.length,
      },
      'davepi-plugin-queue ready'
    );
  }

  return {
    name: 'queue',
    setup,
    enqueue,
    registerJob,
    // Exposed for tests / advanced consumers that need the
    // underlying queue (e.g. to inspect counts in a health probe).
    // Returns null when dormant.
    getQueue: () => state.queue,
    getWorker: () => state.worker,
    isEnabled: () => state.enabled,
  };
}

const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
