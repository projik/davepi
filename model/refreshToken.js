const mongoose = require('mongoose');

/**
 * Stores per-user refresh tokens. The raw token never lives here — only its
 * SHA-256 hash. Mongo's TTL index on `expiresAt` purges expired records
 * automatically, but `revokedAt` is set explicitly when a token is rotated
 * out, replaced, or used after revocation (see reuse-detection in
 * utils/tokens.js).
 *
 * `familyId` groups every token derived from the same login. When a token
 * inside a family is reused after revocation we revoke the whole family —
 * the standard rotation/replay defense.
 */
const RefreshTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('refresh_token', RefreshTokenSchema);
