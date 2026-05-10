const mongoose = require('mongoose');

/**
 * Idempotency key record. Lets clients (and especially agents that
 * retry on transient failures) submit the same logical operation
 * twice without producing duplicate work.
 *
 * Compound unique index on `{ key, userId, route }` so:
 *   - the same key can be reused across users (no cross-tenant
 *     collisions),
 *   - the same key can be reused across routes (a client can cycle
 *     a single key through different operations without managing
 *     uniqueness per call site),
 *   - within a single (key, user, route) tuple, exactly one record
 *     exists — duplicate inserts fail fast at the index level.
 *
 * `expiresAt` carries a TTL index so MongoDB sweeps stale entries
 * automatically (default 24h, override via `IDEMPOTENCY_TTL_SECONDS`).
 *
 * `bodyHash` is the SHA-256 of `JSON.stringify(body)` taken at insert
 * time. Subsequent calls under the same key compare against this
 * hash — same hash = replay the cached response, different hash =
 * 409 IDEMPOTENCY_CONFLICT (so a client can't recycle the same key
 * for a different payload).
 */
const IdempotencyKeySchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    route: { type: String, required: true },
    bodyHash: { type: String, required: true },
    status: { type: Number, required: true },
    body: mongoose.Schema.Types.Mixed,
    headers: mongoose.Schema.Types.Mixed,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

IdempotencyKeySchema.index({ key: 1, userId: 1, route: 1 }, { unique: true });
// Mongo's TTL monitor sweeps documents whose `expiresAt` is in the
// past on a roughly 60s cycle — we don't need to hand-prune.
IdempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.idempotency_key ||
  mongoose.model('idempotency_key', IdempotencyKeySchema);
