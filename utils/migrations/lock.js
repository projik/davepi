/**
 * Single-document lock backed by the `_migrations` collection. The
 * lock is identified by `name === '__lock'`; whichever process wins
 * the upsert race owns the migration run.
 *
 * Stale locks (older than `staleMs`) are reaped by the next caller
 * so a crashed runner doesn't permanently wedge the system. The
 * default 10-minute window is generous for any reasonable migration;
 * tune via env var MIGRATION_LOCK_STALE_MS for long-running ones.
 */

const DEFAULT_STALE_MS = parseInt(
  process.env.MIGRATION_LOCK_STALE_MS || String(10 * 60 * 1000),
  10
);

async function acquireLock(db, { staleMs = DEFAULT_STALE_MS, owner = `${process.pid}@${Date.now()}-${Math.random()}` } = {}) {
  const coll = db.collection('_migrations');
  // Make sure the unique index is in place before the conflict-driven
  // mutex below runs. Without it, both concurrent inserts succeed and
  // the lock is no lock.
  await ensureIndex(db);
  const now = new Date();
  const staleBefore = new Date(Date.now() - staleMs);

  // Step 1: try to acquire by inserting the lock doc.
  try {
    await coll.insertOne({
      name: '__lock',
      lockedAt: now,
      owner,
    });
    return owner;
  } catch (err) {
    // Duplicate key — someone else holds it. Try to reap if stale.
    const existing = await coll.findOne({ name: '__lock' });
    if (existing && existing.lockedAt && existing.lockedAt < staleBefore) {
      // Atomic reap: only swap if the doc still has the same lockedAt.
      const result = await coll.findOneAndUpdate(
        { name: '__lock', lockedAt: existing.lockedAt },
        { $set: { lockedAt: now, owner } }
      );
      if (result.value) return owner;
    }
    return null;
  }
}

async function releaseLock(db, owner) {
  const coll = db.collection('_migrations');
  await coll.deleteOne({ name: '__lock', owner });
}

/**
 * Refresh `lockedAt` so a long-running migration doesn't get its
 * lock reaped under it. Returns true if we still own the lock,
 * false if someone else has stolen / reaped it (in which case the
 * caller MUST abort).
 */
async function renewLock(db, owner) {
  const coll = db.collection('_migrations');
  const result = await coll.findOneAndUpdate(
    { name: '__lock', owner },
    { $set: { lockedAt: new Date() } }
  );
  return Boolean(result.value);
}

async function ensureIndex(db) {
  const coll = db.collection('_migrations');
  await coll.createIndex({ name: 1 }, { unique: true });
}

/**
 * Run `fn(owner)` while heartbeating the lock. The heartbeat fires
 * every `intervalMs` (default: 1/3 of the stale window) and aborts
 * the operation by throwing if our lock has been reaped.
 *
 * Returns whatever `fn` returns. Always releases the lock in
 * `finally`, including on failure to acquire (in which case it
 * never held it and this is a no-op).
 */
async function withHeartbeatedLock(db, fn, {
  staleMs = DEFAULT_STALE_MS,
  intervalMs = Math.max(1000, Math.floor(DEFAULT_STALE_MS / 3)),
} = {}) {
  const owner = await acquireLock(db, { staleMs });
  if (!owner) {
    throw new Error('Could not acquire migration lock — another runner is in flight.');
  }
  let stolen = false;
  const heartbeat = setInterval(async () => {
    try {
      const ok = await renewLock(db, owner);
      if (!ok) stolen = true;
    } catch (_) {
      // Transient errors during heartbeat are non-fatal; the next
      // tick will retry.
    }
  }, intervalMs);
  if (heartbeat.unref) heartbeat.unref();
  try {
    const result = await fn(owner);
    if (stolen) {
      // The lock was reaped while we ran. Surface this so the
      // caller can audit / re-run; the data may be inconsistent.
      throw new Error(
        'Migration lock was reaped during run — another process may have run migrations concurrently.'
      );
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    await releaseLock(db, owner).catch(() => {});
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  renewLock,
  ensureIndex,
  withHeartbeatedLock,
};
