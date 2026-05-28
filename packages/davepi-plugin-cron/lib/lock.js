'use strict';

/**
 * Mongo-backed distributed lock for cron job ticks.
 *
 * Two web/worker processes both wake at the same scheduler tick;
 * exactly one of them runs the handler. We do this with a single
 * collection (`cron_lock`) whose `name` field has a unique index,
 * and an `expiresAt` TTL index so a leaseholder that crashes mid-run
 * doesn't pin the lock forever — Mongo sweeps the stale row and the
 * next tick succeeds.
 *
 * Atomicity is via `findOneAndUpdate({ name, expiresAt: { $lt: now } OR doesn't exist },
 * { $set: { holderId, expiresAt: now + lease } }, { upsert: true })`. Exactly
 * one of the racing processes wins; the others get a duplicate-key
 * error (which we treat as "someone else owns it, skip this tick").
 *
 * Heartbeat: long-running jobs extend the lease every
 * `leaseSeconds/3` by `findOneAndUpdate({ name, holderId }, { $set:
 * { expiresAt: now + lease } })`. If the heartbeat fails twice in a
 * row (another process took over because OUR expiresAt elapsed
 * unnoticed) we flip the AbortSignal so the handler can stop.
 *
 * Index management: this module ASSUMES the indexes have been
 * created by the plugin's setup() ensureIndexes() call. Mongo will
 * happily run the queries without them, but performance and the
 * stale-row sweep depend on them being present.
 */

const crypto = require('crypto');

const COLLECTION = 'cron_lock';

function newHolderId() {
  // Short, sortable-ish, collision-free in practice. We don't need
  // crypto-grade randomness; the holderId is just a tiebreaker for
  // heartbeat ownership and for the status endpoint's display.
  return `${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Try to acquire the lock for `name`. Returns a `lease` object on
 * success, or `null` if another process owns the lock.
 *
 *   lease = {
 *     name, holderId, expiresAt, leaseSeconds,
 *     heartbeat(): Promise<boolean>,   // extends; false if lost
 *     release(): Promise<void>,        // best-effort, idempotent
 *     signal:    AbortSignal,          // flips on lost heartbeat
 *   }
 *
 * The `mongoose` parameter is the injectable mongoose-like object —
 * tests pass a stub with `.connection.db.collection(name)`.
 */
async function acquire({ mongoose, name, leaseSeconds, now = Date.now() }) {
  if (!name || typeof name !== 'string') {
    throw new TypeError('acquire: name is required');
  }
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new TypeError('acquire: leaseSeconds must be a positive number');
  }
  const coll = mongoose.connection.db.collection(COLLECTION);
  const holderId = newHolderId();
  const expiresAt = new Date(now + leaseSeconds * 1000);

  // findOneAndUpdate with a guard that only matches "no row" or
  // "stale row". The unique index on `name` makes upsert race-safe:
  // exactly one of the concurrent processes' upserts succeeds; the
  // others throw E11000, which we map to "lock held — skip."
  try {
    const result = await coll.findOneAndUpdate(
      {
        name,
        // Match a row whose expiresAt is in the past. Atomic with
        // the upsert below so we don't grab a row that's still
        // owned.
        expiresAt: { $lt: new Date(now) },
      },
      {
        $set: { holderId, expiresAt },
        $setOnInsert: { name, createdAt: new Date(now) },
      },
      { upsert: true, returnDocument: 'after' },
    );
    // result.value (driver < 6) or result (driver >= 6) holds the
    // updated doc. We don't care about the shape — getting here
    // without a throw means we own the lease.
    return buildLease({ mongoose, coll, name, holderId, expiresAt, leaseSeconds });
  } catch (err) {
    if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
      // Someone else owns the lock — skip this tick.
      return null;
    }
    throw err;
  }
}

function buildLease({ mongoose, coll, name, holderId, expiresAt, leaseSeconds }) {
  const controller = new AbortController();
  let currentExpiresAt = expiresAt;
  let released = false;

  async function heartbeat({ now = Date.now() } = {}) {
    if (released) return false;
    const next = new Date(now + leaseSeconds * 1000);
    // Only extend if WE still hold the lease. If another process
    // took over because our lease elapsed unnoticed, the matcher
    // doesn't match and findOneAndUpdate returns no document — we
    // surface that as a lost heartbeat.
    const result = await coll.findOneAndUpdate(
      { name, holderId },
      { $set: { expiresAt: next } },
      { returnDocument: 'after' },
    );
    const found = result && (result.value || result.name);
    if (!found) {
      // Lost the lease. Flip the abort signal so the handler can
      // cooperatively stop.
      if (!controller.signal.aborted) controller.abort();
      return false;
    }
    currentExpiresAt = next;
    return true;
  }

  async function release() {
    if (released) return;
    released = true;
    // Best-effort: only delete the row if we still hold it. If
    // another process took over (heartbeat lost), the matcher
    // doesn't match and the row stays in place under their
    // ownership — which is the right outcome.
    try {
      await coll.deleteOne({ name, holderId });
    } catch (_) {
      // Swallow; the TTL index will sweep eventually anyway.
    }
  }

  return {
    name,
    holderId,
    leaseSeconds,
    get expiresAt() { return currentExpiresAt; },
    heartbeat,
    release,
    signal: controller.signal,
  };
}

/**
 * Create the `name` unique index and the `expiresAt` TTL index. Safe
 * to call repeatedly — Mongo `createIndex` is idempotent when the
 * spec matches.
 *
 * The TTL is `expireAfterSeconds: 0` because we want Mongo to sweep
 * a row at the instant `expiresAt` passes (the TTL value IS the
 * absolute expiry time). This matches BullMQ's removeOnFail.age
 * convention and the audit plugin's TTL setup.
 */
async function ensureIndexes(mongoose) {
  const coll = mongoose.connection.db.collection(COLLECTION);
  await coll.createIndex({ name: 1 }, { unique: true, name: 'cron_lock_name_unique' });
  await coll.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'cron_lock_expiresAt_ttl' },
  );
}

module.exports = { acquire, ensureIndexes, COLLECTION };
