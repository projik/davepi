const mongoose = require('mongoose');

/**
 * One-shot password reset tokens. The raw token never lives here — only
 * its SHA-256 hash. Mongo's TTL index on `expiresAt` purges expired records
 * automatically. `usedAt` is set when the reset is consumed; subsequent
 * presentations of the same token are rejected.
 */
const PasswordResetTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('password_reset_token', PasswordResetTokenSchema);
