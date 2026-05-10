---
title: Webhooks
description: Subscribe outbound URLs to schema events — HMAC-signed deliveries with exponential backoff retries and per-attempt audit rows.
---

Schemas can emit signed webhooks on create / update / delete /
restore / state-machine transition. Subscribers receive
HMAC-SHA256-signed POSTs with the same ACL-projected payload as
the audit log.

## Declaration

```js
module.exports = {
  path: 'order',
  fields: [/* ... */],
  webhooks: {
    events: ['created', 'updated', 'deleted', 'restored', 'transitioned'],
    endpoints: [
      {
        url:    'https://hooks.example.com/davepi',
        secret: 'whsec_abc123...',
      },
    ],
  },
};
```

| Key | Description |
|-----|-------------|
| `events` | Subset of `['created', 'updated', 'deleted', 'restored', 'transitioned']`. Defaults to all five. |
| `endpoints` | Array of `{ url, secret }`. Multiple endpoints fan out per event. |

For dynamic subscribers (per-tenant webhooks), declare an empty
endpoints array and manage subscriptions through your own
collection — the framework looks up endpoints per delivery, so a
DB-backed subscription manager works the same as a static config.

## Event shape

```json
{
  "id":         "evt_8f3c...",
  "event":      "order.transitioned",
  "schemaPath": "order",
  "documentId": "65b1...",
  "userId":     "65a0...",
  "data": {
    "before":  { "status": "review" },
    "after":   { "status": "approved" },
    "diff":    { "status": { "from": "review", "to": "approved" } },
    "field":   "status",
    "record":  { /* full record at after-state */ }
  },
  "createdAt": "2026-05-10T12:00:00Z"
}
```

`record` is the full document at the after-state, ACL-projected
the same way responses are. `before` / `after` / `diff` are
present where they apply (no `before` on `created`, no `after` on
`deleted`).

## Signing

Every delivery includes:

```http
POST /your/endpoint HTTP/1.1
Davepi-Event:     order.transitioned
Davepi-Delivery:  dlv_8f3c...
Davepi-Timestamp: 1715342400
Davepi-Signature: sha256=5c6f...
Content-Type:     application/json

{ ...event payload... }
```

`Davepi-Signature` is `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`,
hex-encoded. To verify on the receiver:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(req) {
  const ts  = req.headers['davepi-timestamp'];
  const sig = req.headers['davepi-signature'].slice('sha256='.length);
  const expected = createHmac('sha256', secret)
    .update(`${ts}.${req.rawBody}`)
    .digest('hex');
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

The `${ts}.${rawBody}` construction prevents replay if you also
check timestamp freshness (e.g. reject deliveries older than 5
minutes).

## Retries

| Outcome | What happens |
|---------|--------------|
| 2xx | Success — one audit row, done. |
| 4xx (excluding 408 / 429) | Final failure — endpoint is rejecting. One audit row marked `failed: true`. No retry. |
| 408 / 429 / 5xx / network error | Retry with exponential backoff: 5s, 30s, 2m, 10m, 1h, 6h, 24h. Each attempt writes its own audit row. |

After the final retry, the delivery is abandoned. There's no
manual replay UI yet — to replay, a custom route can re-emit by
running the audit row through `webhookDispatcher.dispatch()`.

## Audit rows for deliveries

Every attempt (success or failure) writes a row to the
`webhook_delivery` collection:

```json
{
  "_id":          "65c0...",
  "deliveryId":   "dlv_8f3c...",
  "endpointUrl":  "https://hooks.example.com/davepi",
  "schemaPath":   "order",
  "event":        "order.transitioned",
  "attempt":      1,
  "status":       200,
  "durationMs":   142,
  "createdAt":    "..."
}
```

Useful for dashboards, debugging, and reconciling what got delivered.

## Tenant scope

Webhook payloads are ALREADY tenant-scoped — the framework only
fires deliveries for events that happened within a tenant, and the
`record` field is ACL-projected the same way it would be on a
read. There's no global firehose: every event is per-tenant.

## What's NOT delivered

- **Audit rows themselves.** Webhooks track schema events, not the audit log. If you want every audit row mirrored externally, write a custom route.
- **Search / aggregation invocations.** Reads don't fire events.
- **`__includeDeleted` reads.** Same — reads, not events.

## See also

- [State machines](/features/state-machines/) — `<path>.transitioned` events.
- [ACL](/features/acl/) — projection on payload.
- [Audit log](/features/audit/) — same projection as webhook payloads.
