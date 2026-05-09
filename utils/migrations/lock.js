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

async function ensureIndex(db) {
  const coll = db.collection('_migrations');
  await coll.createIndex({ name: 1 }, { unique: true });
}

module.exports = { acquireLock, releaseLock, ensureIndex };
