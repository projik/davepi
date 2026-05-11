---
title: Webhooks
description: Subscribe outbound URLs to record events via POST /api/v1/webhooks — HMAC-signed deliveries, event-pattern matching, exponential-backoff retries.
---

Outbound webhooks let downstream systems react to record
lifecycle events without polling. Subscriptions are registered
at runtime (`POST /api/v1/webhooks`) — they're per-tenant data,
not schema config.

The framework emits a record event whenever a tracked schema's
auto-generated route mutates a document; the webhook dispatcher
finds every active subscription whose `events` list matches the
event type and POSTs an HMAC-signed payload to its URL.

## Creating a subscription

```bash
curl -X POST https://api.example.com/api/v1/webhooks \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "events": ["order.created", "order.transitioned", "account.*"],
    "url":    "https://hooks.example.com/davepi"
  }'
```

Response (the `secret` field is shown **exactly once** —
subsequent reads omit it):

```json
{
  "_id":             "<sub-id>",
  "userId":          "<tenant>",
  "events":          ["order.created", "order.transitioned", "account.*"],
  "url":             "https://hooks.example.com/davepi",
  "active":          true,
  "failureCount":    0,
  "secret":          "<32-byte hex>",
  "createdAt":       "...",
  "updatedAt":       "..."
}
```

Stash the `secret` somewhere safe; you can't recover it later.
If you lose it, delete the subscription and create a new one.

## Event patterns

| Pattern | Matches |
|---------|---------|
| `order.created` | Exact event type. |
| `order.*` | Every `order.<verb>` event (`created`, `updated`, `deleted`, `transitioned`). |
| `*` | Every event the tenant emits. Useful for catch-all integrations. |

## Emitted event types

The framework emits these for every schema:

| Event type | When |
|-----------|------|
| `<path>.created` | Auto-generated `POST /api/v1/<path>` succeeds, or a GraphQL create mutation does. |
| `<path>.updated` | `PUT /api/v1/<path>/:id`, bulk-update PUT, or GraphQL update mutation. |
| `<path>.deleted` | `DELETE /api/v1/<path>/:id`, bulk-delete, or GraphQL delete mutation. |
| `<path>.transitioned` | State-machine transition (REST PUT changing the state field, GraphQL `<path>Transition<Field>`, or MCP equivalent). |

`<path>` is the schema's `path` declaration. There's no
`<path>.restored` event today — soft-restore emits a `.updated`.

## Delivery shape

Each delivery is a POST with the headers:

```http
X-davepi-Signature: sha256=<hex>
X-davepi-Event:     order.created
X-davepi-Delivery:  <uuid>
Content-Type:       application/json
```

And the body:

```json
{
  "id":          "<uuid>",
  "type":        "order.created",
  "version":     "v1",
  "userId":      "<tenant>",
  "recordId":    "<doc-id>",
  "record":      { /* the affected document */ },
  "deliveredAt": "2026-05-11T12:00:00Z"
}
```

For **bulk** mutations (PUT against a query, bulk-delete), the
payload swaps `recordId` + `record` for:

```json
{
  "id":          "<uuid>",
  "type":        "order.updated",
  "version":     "v1",
  "userId":      "<tenant>",
  "filter":      { /* the query that matched */ },
  "numAffected": 47,
  "deliveredAt": "..."
}
```

**No `before` document is delivered today.** If the receiver
needs the prior state, query the record's audit log via
`GET /api/v1/<path>/:id/history`.

## Signing & verification

```js
const crypto = require('node:crypto');

function verify(req, secret) {
  const sig = req.headers['x-davepi-signature'] || '';
  if (!sig.startsWith('sha256=')) return false;
  const provided = sig.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', secret)
    .update(req.rawBody)                       // not the parsed JSON!
    .digest('hex');
  // timing-safe compare
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

`req.rawBody` is the raw request body (use a middleware that
preserves it, e.g. `express.raw({ type: 'application/json' })`
or `bodyParser.json({ verify: (req, _, buf) => req.rawBody = buf })`).

## Retries & failure handling

| Outcome | What happens |
|---------|--------------|
| HTTP 2xx | Success — `failureCount` reset to 0, `lastDeliveryAt` updated. |
| Non-2xx, timeout (10s), network error | Retry on the backoff schedule: 1s, 5s, 30s, 5min, 1h. Each attempt counts. |
| 10 consecutive failures across deliveries | The subscription is auto-disabled (`active: false`). Re-enable manually after fixing the receiver. |

Deliveries are **at-least-once** — a delivery may be retried
even if your receiver eventually returned 2xx for a prior
attempt. **Receivers must be idempotent.** Use the
`X-davepi-Delivery` header (the delivery's `id`) as a
deduplication key.

## Testing a subscription

`POST /api/v1/webhooks/:id/test` fires a synthetic
`webhook.test` event to the subscription's URL — useful for
verifying the receiver's signature check without waiting for a
real mutation.

## Subscription management

| Verb | Path | Notes |
|------|------|-------|
| `POST` | `/api/v1/webhooks` | Create. Returns the `secret` exactly once. |
| `GET` | `/api/v1/webhooks` | List the caller's subscriptions (secrets omitted). |
| `GET` | `/api/v1/webhooks/:id` | Read one (secret omitted). |
| `DELETE` | `/api/v1/webhooks/:id` | Delete. |
| `POST` | `/api/v1/webhooks/:id/test` | Hand-fire a `webhook.test` event. |

All routes are tenant-scoped — subscriptions belong to the
creating user's `userId`.

## SSRF protection

On create, the URL is validated against private / loopback /
link-local ranges and against DNS resolutions that point at
them. In `NODE_ENV=test` this check is relaxed so a local
Express receiver bound to `127.0.0.1` can receive deliveries
during the test suite; production rejects loopback URLs.

## What's NOT delivered

- **Audit rows themselves.** Webhooks track schema events, not the audit log. If you want every audit row mirrored externally, write a custom route.
- **Search / aggregation reads.** Reads don't emit events.
- **Cross-tenant fan-out.** A subscription created by tenant A only sees events that happened in tenant A's scope.

## See also

- [State machines](/features/state-machines/) — `<path>.transitioned` events.
- [ACL](/features/acl/) — projection applied to the `record` field on delivery.
- [Audit log](/features/audit/) — same per-record history that webhook receivers can look up via `/history`.
