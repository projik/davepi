const mongoose = require('mongoose');

/**
 * Per-user webhook subscription. The framework dispatches a signed
 * HTTP POST to `url` whenever an event matching one of `events` is
 * emitted from the same user's records.
 *
 * `secret` is generated server-side, returned to the caller exactly
 * once at create time, and stored in plaintext (so the dispatcher
 * can sign payloads with it). Treat it like a credential —
 * regeneration requires deleting and re-creating the subscription.
 *
 * `failureCount` tracks consecutive delivery failures; the dispatcher
 * flips `active` to false after a configurable threshold so a single
 * bad endpoint can't accumulate retry pressure forever.
 */
const WebhookSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    // Event-type matchers. Supports exact ('account.created'),
    // resource-wildcards ('account.*'), and a global '*'.
    events: { type: [String], required: true, default: [] },
    url: { type: String, required: true },
    secret: { type: String, required: true },
    active: { type: Boolean, default: true, index: true },
    failureCount: { type: Number, default: 0 },
    lastDeliveryAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    lastFailureReason: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('webhook', WebhookSchema);
