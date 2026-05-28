'use strict';

/**
 * Lazy Mongoose models for OTP rate limiting and challenge storage.
 * The plugin defers loading mongoose until setup time so the package's
 * unit tests can run without mongoose installed — tests inject stub
 * model objects with `findOneAndUpdate` / `deleteOne` shaped just
 * enough to drive the route handlers.
 */

let cachedOtpChallenge = null;
let cachedOtpRate = null;

function getOtpChallengeModel(mongoose) {
  if (cachedOtpChallenge) return cachedOtpChallenge;
  const m = mongoose || require('mongoose');
  if (m.models && m.models.OtpChallenge) {
    cachedOtpChallenge = m.models.OtpChallenge;
    return cachedOtpChallenge;
  }
  const schema = new m.Schema({
    phone:     { type: String, required: true, index: true },
    codeHash:  { type: String, required: true },
    attempts:  { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  }, { collection: 'otp_challenge', timestamps: true });
  // TTL: Mongo removes the doc once `expiresAt` is reached.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  cachedOtpChallenge = m.model('OtpChallenge', schema);
  return cachedOtpChallenge;
}

function getOtpRateModel(mongoose) {
  if (cachedOtpRate) return cachedOtpRate;
  const m = mongoose || require('mongoose');
  if (m.models && m.models.OtpRate) {
    cachedOtpRate = m.models.OtpRate;
    return cachedOtpRate;
  }
  const schema = new m.Schema({
    phone:       { type: String, required: true, unique: true },
    count:       { type: Number, default: 0 },
    windowStart: { type: Date, default: () => new Date() },
    expiresAt:   { type: Date, required: true },
  }, { collection: 'otp_rate', timestamps: true });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  cachedOtpRate = m.model('OtpRate', schema);
  return cachedOtpRate;
}

// Test-only: forget cached instances so a different mongoose stub can
// be re-injected by the next createPlugin() invocation.
function _resetModelCache() {
  cachedOtpChallenge = null;
  cachedOtpRate = null;
}

module.exports = { getOtpChallengeModel, getOtpRateModel, _resetModelCache };
