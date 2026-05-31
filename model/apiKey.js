const mongoose = require('mongoose');

/**
 * Long-lived, revocable, scope-limited API keys for programmatic
 * access. The raw key never lives here — only its SHA-256 hash. The
 * plaintext is shown exactly once at creation (see the
 * /api/auth/api-keys POST route) and can never be recovered.
 *
 * A request bearing an API key resolves to the same `req.user` shape
 * as a JWT (`user_id`, `email`, `roles`) plus `scopes` and
 * `authMethod: 'apiKey'`, so existing tenant scoping, ACL, and the
 * GraphQL scopeResolver wrappers keep working unchanged — see
 * middleware/auth.js.
 *
 * `roles` are stamped from the minting user at creation and read back
 * from THIS record on every request (never re-fetched from the User),
 * so a key can't be elevated beyond what it was minted with even if
 * the owner later gains new roles. `email` is denormalised here for
 * the same reason: populating req.user.email without a second query.
 */
const ApiKeySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    // Denormalised from the minting user so req.user.email can be
    // populated on each request without a User lookup.
    email: { type: String, default: null },
    name: { type: String, required: true },
    // First ~8 chars of the key (`dpk_xxxx`) — safe to display so the
    // owner can recognise a key in a list without revealing the secret.
    prefix: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    scopes: { type: [String], default: ['read', 'write'] },
    // Subset of the minting user's roles, frozen at creation.
    roles: { type: [String], default: ['user'] },
    lastUsedAt: { type: Date, default: null },
    // Nullable: a null expiry means the key never expires. The TTL
    // index purges nothing here — expiry is enforced in the auth
    // lookup so the row survives for audit/listing after it lapses.
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('api_key', ApiKeySchema);
