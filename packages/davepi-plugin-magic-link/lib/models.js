'use strict';

/**
 * Mongoose model for the magic-link token store.
 *
 * Deliberately un-tenanted: verification runs BEFORE the caller is
 * authenticated, so it cannot go through davepi's per-user-scoped
 * CRUD surface. Only the SHA-256 hash of the emailed token is stored
 * — never the token itself — so a database read can't be replayed
 * into a session.
 *
 * The TTL index on `expiresAt` is a janitor, not the security gate:
 * Mongo's TTL monitor runs roughly once a minute, so the verify query
 * still enforces expiry at read time.
 */

function getMagicLinkTokenModel(mongoose) {
  if (mongoose.models.magic_link_token) {
    return mongoose.models.magic_link_token;
  }

  const schema = new mongoose.Schema(
    {
      email: { type: String, index: true },
      tokenHash: { type: String, index: true },
      purpose: {
        type: String,
        enum: ['login', 'invite'],
        default: 'login',
      },
      userId: { type: String },
      meta: { type: mongoose.Schema.Types.Mixed, default: null },
      expiresAt: { type: Date, required: true },
      usedAt: { type: Date, default: null },
    },
    { timestamps: true }
  );
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  return mongoose.model('magic_link_token', schema);
}

module.exports = { getMagicLinkTokenModel };
