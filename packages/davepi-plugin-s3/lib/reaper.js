'use strict';

/**
 * Pending-record reaper.
 *
 * A `file` record is created in `status: 'pending'` when the upload-url
 * route hands the client a presigned PUT URL. If the client never
 * completes the upload (closed laptop, network drop, abandoned UI),
 * the record sits in the DB and the partial blob — if any reached the
 * bucket before the URL expired — sits in storage forever.
 *
 * This module exposes a `setInterval`-driven sweep:
 *
 *   - finds `pending` records older than
 *     `putUrlTtlSeconds * reapMultiplier` seconds
 *   - calls the adapter's `deleteObject` on each key (best-effort —
 *     the object usually doesn't exist, in which case `headObject`
 *     reports 404 and we skip the delete call to save a round trip)
 *   - removes the DB record
 *
 * Operators can disable the in-process reaper by setting
 * `S3_REAP_ENABLED=false` (e.g. for projects that run the cron plugin
 * to drive cleanup at their own cadence; the reaper exports `runOnce`
 * for those cases).
 */

function createReaper({ getModel, adapter, config, log }) {
  let timer = null;
  let inflight = false;

  const ttlMs = config.putUrlTtlSeconds * config.reapMultiplier * 1000;

  async function runOnce({ now = Date.now() } = {}) {
    if (inflight) return { skipped: true, reason: 'already running' };
    inflight = true;
    let deleted = 0;
    try {
      const Model = getModel();
      if (!Model) return { deleted: 0, reason: 'no model' };
      const cutoff = new Date(now - ttlMs);
      // The framework's collection has `createdAt` from mongoose-timestamp.
      // We deliberately use `createdAt` (not `updatedAt`) so a /complete
      // retry that touches the doc doesn't reset the reap clock for a
      // record that's still stuck in `pending`.
      const stale = await Model.find({
        status:    'pending',
        createdAt: { $lt: cutoff },
      }).limit(100);

      for (const doc of stale) {
        try {
          // Always issue the delete: cheaper than a HEAD round-trip,
          // and adapter implementations swallow 404s for us.
          await adapter.deleteObject({ key: doc.key });
        } catch (err) {
          // Storage failure: log and skip removing the DB row, so the
          // next sweep retries. The DB row stays in `pending` and
          // remains over the cutoff threshold, so it's picked up again
          // — no lost work.
          if (log && typeof log.warn === 'function') {
            log.warn(
              { err, plugin: 's3', key: doc.key },
              'davepi-plugin-s3: reaper failed to delete storage object; will retry'
            );
          }
          continue;
        }
        try {
          await Model.deleteOne({ _id: doc._id });
          deleted += 1;
        } catch (err) {
          if (log && typeof log.warn === 'function') {
            log.warn(
              { err, plugin: 's3', fileId: String(doc._id) },
              'davepi-plugin-s3: reaper failed to delete pending record; will retry'
            );
          }
        }
      }
      return { deleted };
    } finally {
      inflight = false;
    }
  }

  function start() {
    if (timer) return;
    if (!config.reapEnabled) return;
    timer = setInterval(() => {
      runOnce().catch((err) => {
        // Last-resort: a thrown error escaping runOnce would crash the
        // setInterval task on older Node versions. Belt-and-suspenders.
        if (log && typeof log.error === 'function') {
          log.error(
            { err, plugin: 's3' },
            'davepi-plugin-s3: reaper sweep threw unexpectedly'
          );
        }
      });
    }, config.reapIntervalMs);
    // Don't pin the event loop — a process whose only remaining task
    // is the reaper interval should still exit cleanly.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce };
}

module.exports = { createReaper };
