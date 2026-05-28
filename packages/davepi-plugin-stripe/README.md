# davepi-plugin-stripe

Stripe payments + subscriptions + webhooks for [dAvePi](https://docs.davepi.dev).
First-party plugin distributed as its own npm package.

```bash
npm install davepi-plugin-stripe stripe
```

Register it in your project's `package.json`:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-stripe"]
  }
}
```

Configure via env:

| Variable                  | Required           | Default                  | Description                                              |
| ------------------------- | ------------------ | ------------------------ | -------------------------------------------------------- |
| `STRIPE_SECRET_KEY`       | yes (else dormant) | —                        | `sk_test_...` / `sk_live_...`                            |
| `STRIPE_WEBHOOK_SECRET`   | yes for webhook    | —                        | `whsec_...` — needed for signature verification          |
| `STRIPE_WEBHOOK_PATH`     | no                 | `/api/webhooks/stripe`   | Empty disables the route                                 |
| `STRIPE_CHECKOUT_PATH`    | no                 | `/api/checkout`          | Empty disables                                           |
| `STRIPE_PORTAL_PATH`      | no                 | `/api/portal`            | Empty disables                                           |
| `STRIPE_API_VERSION`      | no                 | latest                   | Pin to avoid surprise API drift                          |
| `STRIPE_AUTOMATIC_TAX`    | no                 | `false`                  | Toggles Stripe Tax on Checkout                           |

If `STRIPE_SECRET_KEY` is unset, the plugin logs a warning and stays dormant.
The same posture applies to the webhook: if `STRIPE_WEBHOOK_PATH` is set but
`STRIPE_WEBHOOK_SECRET` is missing, the route is **not** mounted — an
unverified webhook endpoint is worse than no endpoint.

## What you get

### `POST /api/checkout`

Authenticated (real JWT — client-id callers are refused with 403). Request body:

```json
{
  "priceId": "price_xyz",
  "mode": "subscription",
  "successUrl": "https://app.example.com/billing/success",
  "cancelUrl":  "https://app.example.com/billing/cancel",
  "quantity": 1,
  "allowPromotionCodes": true
}
```

Response:

```json
{ "url": "https://checkout.stripe.com/c/pay/cs_test_...", "id": "cs_test_..." }
```

The plugin auto-creates a Stripe customer for the user on first hit and
records `stripeCustomerId` on the User document.

### `POST /api/portal`

Authenticated. Request body:

```json
{ "returnUrl": "https://app.example.com/account" }
```

Response: `{ "url": "https://billing.stripe.com/p/session/..." }`.

### `POST /api/webhooks/stripe`

Public endpoint. Stripe POSTs verified events here; the plugin:

1. Verifies the `Stripe-Signature` header via `stripe.webhooks.constructEvent`
   (timing-safe HMAC under the hood).
2. Inserts `event.id` into `stripe_event_seen` (TTL 7 days). Duplicate → 200 +
   short-circuit, no double-processing on Stripe retries.
3. ACKs Stripe with `200 { received: true }` immediately.
4. Syncs the `stripe_subscription` mirror for `customer.subscription.*` events.
5. Rebroadcasts onto the framework's record bus as
   `record` events typed `stripe.<event.type>` so audit / slack / postmark
   plugins compose without extra wiring.

### `stripe_subscription` (auto-registered schema)

REST: `GET /api/stripe_subscription`, etc. GraphQL: `stripeSubscriptionFindMany`
and friends. Tenant-scoped by `userId`. Fields include `status`, `priceId`,
`currentPeriodEnd`, `cancelAtPeriodEnd`, and a `raw` payload of the last
subscription object from Stripe so consumers can read any field without a
schema migration.

### `stripe_event_seen` (auto-registered schema)

Idempotency dedupe. The framework's auto-generated REST/GraphQL is incidental
— operators can see what's been processed.

## Programmatic API

```js
const stripe = require('davepi-plugin-stripe');

// From a schema lifecycle hook
const session = await stripe.createCheckoutSession({
  user: req.user,
  priceId: 'price_xyz',
  mode: 'subscription',
  successUrl: 'https://app/.../success',
  cancelUrl:  'https://app/.../cancel',
});
// session.url

const portal = await stripe.createPortalSession({
  user: req.user,
  returnUrl: 'https://app/.../account',
});

// Subscribe to verified webhook events directly
stripe.onWebhookEvent('customer.subscription.updated', async (event) => {
  // event is the raw Stripe Event object
});

// Direct SDK access (escape hatch)
const client = stripe.client; // new Stripe(secret)
await client.invoices.list({ customer: 'cus_...' });
```

All helpers throw with a clear message if called while the plugin is dormant.

## Customer-creation race

Two concurrent first-hits from the same user could race to create two Stripe
customers. The plugin uses an `Idempotency-Key` of `davepi-customer-<user_id>`
on `customers.create` so Stripe coalesces the duplicate server-side. The
local `stripeCustomerId` pointer is `findByIdAndUpdate` (last-write-wins);
either id remains valid for the same Stripe customer.

## Notes on raw-body

The webhook handler verifies the request's raw bytes against the
`Stripe-Signature` header. The framework's `express.json()` mount uses a
`verify` callback that stashes the raw buffer on `req.rawBody`, so signature
verification works without per-path middleware reordering. If you're on a
framework version older than the one that ships this hook, the webhook
handler returns 400 with a diagnostic.

## License

ISC
