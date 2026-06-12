'use strict';

/**
 * Schema-driven resources owned by davepi-plugin-stripe. Registered
 * via `schemaLoader.loadSchema(...)` during plugin setup so the
 * framework auto-generates Mongoose models, REST routes (under
 * `/api/<path>/...`), Swagger fragments, and GraphQL types just like
 * any other resource declared under `schema/versions/v1/`.
 *
 * Two collections:
 *
 *   - `stripe_event_seen` — idempotency dedupe for inbound webhooks.
 *     Stripe retries failed deliveries; the webhook handler inserts
 *     the event id pre-fan-out and short-circuits on duplicate
 *     insert. The framework's auto-generated REST/GraphQL is
 *     incidental (operators can see what's been processed); the
 *     primary consumer is the plugin's own webhook handler going
 *     direct to the Mongoose model. TTL is 7d (Stripe's max retry
 *     window is 72h, so a week leaves plenty of headroom for
 *     manual replays from the dashboard).
 *
 *   - `stripe_subscription` — local mirror of subscription state.
 *     Kept in sync by the webhook handler so customer-facing
 *     surfaces (a /billing page, a "your plan" widget) can query
 *     via REST/GraphQL without round-tripping Stripe on every page
 *     load. The mirror is **best-effort** — the source of truth is
 *     always Stripe; if the mirror diverges (e.g. a missed webhook
 *     during a deploy), refetch via `stripe.client.subscriptions.list`
 *     and replay.
 *
 * `stripe_subscription` declares `userId`, so the framework's
 * tenant-isolation machinery (the auto-generated route handlers +
 * GraphQL resolvers wrapped via `utils/scopeResolver`) scopes reads
 * to the calling user automatically; the plugin's webhook handler
 * stamps `userId` during write — looked up via the `stripeCustomerId`
 * field on the User model. `stripe_event_seen` is intentionally NOT
 * tenant-scoped — it's a global webhook-dedupe ledger keyed by Stripe
 * event id, not user-owned data — so it sets `tenantScoped: false` to
 * opt out of the framework's require-`userId` guardrail and relies on
 * a `schema.acl.list` admin bypass for operator visibility (see below).
 */

const stripeEventSeenSchema = {
  path: 'stripe_event_seen',
  collection: 'stripe_event_seen',
  version: 'v1',
  // Not user-owned data, so this schema has no `userId` field and opts
  // out of the framework's require-`userId` tenant-isolation guardrail.
  tenantScoped: false,
  // Dedupe rows aren't tenant-scoped data — they're operator
  // diagnostics ("did Stripe deliver this event yet?"). The
  // framework's scoped resolvers $and a `{ userId: caller }` filter
  // onto every read; without the list ACL bypass these rows would
  // be invisible through the auto-generated REST/GraphQL surface
  // even to the user the event maps to. Same posture davepi-plugin-audit
  // uses on its `audit` rows.
  acl: {
    list:   ['admin'],
    delete: ['admin'],
  },
  fields: [
    { name: 'eventId', type: String, required: true, unique: true, index: true },
    { name: 'eventType', type: String, required: true },
    // Loose link to the customer the event is about. Optional —
    // some Stripe events (account.*, invoice.created on a checkout
    // session before the customer exists) don't carry a customer.
    // Indexed for operator queries like "show me everything we
    // saw for cus_xxx".
    { name: 'stripeCustomerId', type: String, index: true },
    // TTL index: documents expire 7 days after the stored date.
    // Mongoose honours `expires: 0` on a Date field by emitting
    // a `{ expireAfterSeconds: 0 }` TTL index.
    { name: 'expiresAt', type: Date, required: true, expires: 0 },
  ],
};

const stripeSubscriptionSchema = {
  path: 'stripe_subscription',
  collection: 'stripe_subscription',
  version: 'v1',
  fields: [
    { name: 'userId', type: String, required: true, index: true },
    { name: 'stripeCustomerId', type: String, required: true, index: true },
    { name: 'subscriptionId', type: String, required: true, unique: true, index: true },
    { name: 'status', type: String, required: true },
    { name: 'priceId', type: String },
    { name: 'productId', type: String },
    { name: 'currentPeriodStart', type: Date },
    { name: 'currentPeriodEnd', type: Date },
    { name: 'cancelAtPeriodEnd', type: Boolean, default: false },
    { name: 'canceledAt', type: Date },
    // Last full subscription object from Stripe, kept as an opaque
    // payload so consumers can read any field Stripe ever emits
    // without forcing a schema migration here. Indexed-fields above
    // cover the common query paths (status, customer, period end).
    { name: 'raw', type: Object },
  ],
};

module.exports = {
  stripeEventSeenSchema,
  stripeSubscriptionSchema,
};
