'use strict';

/**
 * Mongoose model for the `oauth_identity` collection — the per-provider
 * link record that lets one local User have multiple social logins.
 *
 * Loaded lazily because the package is peer-dep-only on mongoose: the
 * framework brings mongoose in via `davepi`, and at setup time we
 * resolve the same instance the framework uses (so models register
 * onto the same connection).
 *
 * Tests inject a stub via `createPlugin({ OAuthIdentity })` to avoid
 * connecting Mongo at all.
 */

let cachedModel = null;

function buildSchema(mongoose) {
  const schema = new mongoose.Schema(
    {
      userId:         { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
      provider:       { type: String, required: true },
      providerUserId: { type: String, required: true },
      email:          { type: String, default: null },
      profile:        { type: mongoose.Schema.Types.Mixed, default: null },
      linkedAt:       { type: Date, default: Date.now },
      lastLoginAt:    { type: Date, default: Date.now },
    },
    { collection: 'oauth_identity' }
  );
  // (provider, providerUserId) is the natural unique key. If two
  // calls race to link the same provider identity, the second one
  // gets a duplicate-key error and falls back to the existing row.
  schema.index({ provider: 1, providerUserId: 1 }, { unique: true });
  return schema;
}

function getOAuthIdentityModel(mongooseInstance) {
  if (cachedModel) return cachedModel;
  const mongoose = mongooseInstance || require('mongoose');
  if (mongoose.models && mongoose.models.oauth_identity) {
    cachedModel = mongoose.models.oauth_identity;
    return cachedModel;
  }
  cachedModel = mongoose.model('oauth_identity', buildSchema(mongoose));
  return cachedModel;
}

// For tests that want a fresh cache.
function _resetCache() { cachedModel = null; }

module.exports = { getOAuthIdentityModel, buildSchema, _resetCache };
