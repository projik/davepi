'use strict';

/**
 * Admin-gated cron status + manual-run router.
 *
 *   GET  <path>            → { jobs: [{ name, schedule, timezone,
 *                              nextRun, lastRun, lastStatus,
 *                              lastDurationMs, lastError, runCount,
 *                              failCount }] }
 *   POST <path>/:name/run-now → { ok: true, scheduled: true }
 *
 * Both routes refuse callers without the `admin` role — cron is
 * operator infrastructure, not per-tenant data. We deliberately
 * return 403 (not 404) on a missing role because the route's
 * existence is documented; hiding it would force operators to
 * guess.
 *
 * `errors`, `asyncHandler`, and `express` are injected so the
 * package's own unit tests run without davepi installed; the
 * setup() pass resolves them via `require('davepi/...')` at
 * boot time.
 */

function buildRouter({ express, errors, asyncHandler, jobs, runNow, log }) {
  const { ForbiddenError, NotFoundError, ValidationError } = errors;
  const router = express.Router();

  function requireAdmin(req, _res, next) {
    const roles = (req.user && req.user.roles) || [];
    if (!Array.isArray(roles) || !roles.includes('admin')) {
      return next(new ForbiddenError('admin role required'));
    }
    return next();
  }

  router.get('/', requireAdmin, asyncHandler(async (_req, res) => {
    const list = jobs.list().map((j) => ({
      name:           j.name,
      schedule:       j.schedule,
      timezone:       j.timezone || null,
      leaseSeconds:   j.leaseSeconds,
      nextRun:        j.nextRun ? new Date(j.nextRun).toISOString() : null,
      lastRun:        j.lastRun ? new Date(j.lastRun).toISOString() : null,
      lastStatus:     j.lastStatus || null,
      lastDurationMs: j.lastDurationMs != null ? j.lastDurationMs : null,
      lastError:      j.lastError || null,
      runCount:       j.runCount || 0,
      failCount:      j.failCount || 0,
    }));
    res.json({ jobs: list });
  }));

  router.post('/:name/run-now', requireAdmin, asyncHandler(async (req, res, next) => {
    const name = req.params.name;
    const job = jobs.get(name);
    if (!job) return next(new NotFoundError('cron job'));
    // Don't await the handler — manual-run is fire-and-forget for
    // the HTTP caller, exactly like the scheduled path. The job's
    // own log lines / status row are how the admin checks the
    // outcome. We DO await the lock-acquisition decision so the
    // response can report whether another node was already
    // holding the lease.
    let outcome;
    try {
      outcome = await runNow(name);
    } catch (err) {
      // Internal-error details stay in the operator log only. The
      // HTTP client sees a generic typed error — never the caught
      // err.message, which can leak driver / Mongo internals.
      log.error({ err, plugin: 'cron', name }, 'manual run-now failed to start');
      return next(new ValidationError('could not start cron job'));
    }
    res.json({ ok: true, ...outcome });
  }));

  return router;
}

module.exports = { buildRouter };
