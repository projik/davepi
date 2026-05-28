'use strict';

/**
 * Builds the tenant-scoped job-status route.
 *
 *   GET <statusPath>/:id  →  { id, name, status, attempts, lastError, returnValue, progress }
 *
 * Multi-tenancy: when the job was enqueued, the plugin stamped
 * `data.userId` (and `data.accountId` if the caller had one) onto the
 * BullMQ job payload. This handler refuses to return a job whose
 * stamped `userId` doesn't match `req.user.user_id` — same invariant
 * as every auto-generated REST route in the framework.
 *
 * `errors` is the framework's typed-error module (resolved lazily at
 * setup time via `require('davepi/utils/errors')`) so the response
 * shape matches the rest of the API.
 */
function buildStatusRouter({ express, getQueue, errors, log }) {
  const { NotFoundError, ForbiddenError } = errors;
  const router = express.Router();

  router.get('/:id', async (req, res, next) => {
    try {
      const queue = getQueue();
      if (!queue) {
        // Plugin should be enabled before this route is mounted, but
        // belt-and-braces: a getQueue() that returns null means setup
        // never finished. Treat as 404 rather than 500 — the route
        // exists but the job doesn't.
        return next(new NotFoundError('job not found'));
      }
      const userId = req.user && req.user.user_id;
      if (!userId) {
        // auth(true) is supposed to be mounted ahead of this router;
        // this is defence-in-depth in case the consumer mounts it
        // without auth by mistake.
        return next(new ForbiddenError('authentication required'));
      }
      const job = await queue.getJob(req.params.id);
      if (!job) return next(new NotFoundError('job not found'));

      const stampedUserId = job.data && job.data.userId;
      // String() because callers may have JWT user_id as ObjectId
      // string while the stamped value is whatever was passed in.
      if (!stampedUserId || String(stampedUserId) !== String(userId)) {
        // Don't disclose that the job exists at all — same posture
        // as auto-generated GET /:id when the doc belongs to a
        // different tenant.
        return next(new NotFoundError('job not found'));
      }

      const state = await job.getState();
      const attemptsMade = job.attemptsMade != null ? job.attemptsMade : 0;
      const returnValue = job.returnvalue != null ? job.returnvalue : null;
      const lastError = job.failedReason || null;
      const progress = job.progress != null ? job.progress : 0;

      res.json({
        id: String(job.id),
        name: job.name,
        status: state,
        attempts: attemptsMade,
        lastError,
        returnValue,
        progress,
      });
    } catch (err) {
      log.error({ err, plugin: 'queue' }, 'job-status lookup failed');
      next(err);
    }
  });

  return router;
}

module.exports = { buildStatusRouter };
