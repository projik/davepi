---
title: Idempotency keys
description: Stripe-style idempotency on every POST and every create_<path> MCP tool — agents can retry safely.
---

Agents (and humans) retry. A flaky network, a model timeout, a
harness restart — and a `POST` that succeeded in flight gets re-sent,
creating a duplicate record. Idempotency keys close that gap: a
client tags each logical operation with a stable string, and the
server guarantees the same operation runs at most once per key.

dAvePi implements the [Stripe-style](https://stripe.com/docs/api/idempotent_requests)
contract on every auto-generated `POST` route, plus on every MCP
`create_<path>` tool.

## REST: `Idempotency-Key` header

```http
POST /api/v1/account
Authorization: Bearer <token>
Idempotency-Key: 9f3c1c2e-...
Content-Type: application/json

{ "accountName": "Acme" }
```

The server returns the response with `201 Created` on the first
call. A retry with the **same key + same body** returns the **same
response**, with an extra header:

```http
Idempotency-Replay: true
```

So the agent can tell whether it actually ran the operation or just
got a cached result.

## Conflict: same key, different body

If the same key is used with a different request body, the server
rejects with `409 IDEMPOTENCY_CONFLICT`:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "Idempotency-Key was reused with a different request body"
  }
}
```

This is the safe response: the server can't know whether the agent
meant "retry the previous call" (in which case the body shouldn't
change) or "new operation under a recycled key" (which is an agent
bug). Refusing to do anything is correct.

The body hash is computed over the **effective post-filter payload**
(after `filterWritable` and after server-side tenant stamping), not
over the raw request body. So two retries that the server treats as
identical — e.g. one with an ACL-stripped field, one without — still
hash the same and replay rather than false-conflict. The hash is
also key-order independent: `{a:1,b:2}` and `{b:2,a:1}` match.

## Concurrent retries: claim-execute-complete

The server uses a claim-execute-complete protocol so two concurrent
requests with the same `(key, userId, route)` can't both create
resource records:

1. **Claim.** An atomic `INSERT` (gated by the unique index) marks the row `in_progress`. Exactly one concurrent caller wins.
2. **Execute.** The winner runs the handler. The losers see the existing row and:
   - Same body hash, `in_progress` → `409 IDEMPOTENCY_IN_PROGRESS` ("retry shortly").
   - Same body hash, `completed` → replay the cached response.
   - Different body hash → `409 IDEMPOTENCY_CONFLICT`.
3. **Complete (or abandon).** On a 2xx, the winner promotes the row to `completed` with the response. On a non-2xx (or a thrown error), the winner deletes the row so the agent can fix its payload and retry under the same key.

The unique index on `{ key, userId, route }` is what makes this
race-safe — the database, not the application, decides who claims
a slot.

## Scoping rules

Keys are scoped per `(key, user, route)`:

- **Per user**: User A and User B can use the same key without colliding.
- **Per route**: the same key on `POST /api/v1/account` and `POST /api/v1/contact` does not deduplicate across routes.
- **Per body hash**: same `(key, user, route)` with a changed body → 409.

The unique index on `{ key, userId, route }` enforces this at the
storage layer.

## What is and isn't cached

- **2xx responses**: cached for the configured TTL.
- **Non-2xx responses**: NOT cached. An agent that posted a malformed payload, got a `400 VALIDATION`, then fixed the payload and retried with the **same key** will see the corrected request go through. We don't trap agents in their own mistakes.
- **No header**: middleware is a no-op. Existing clients that don't set `Idempotency-Key` see exactly the previous behaviour.

## TTL

Default 24 hours. Override via `IDEMPOTENCY_TTL_SECONDS` in `.env`.
MongoDB's TTL monitor sweeps expired records automatically on its
background cycle (~60s cadence).

A 24h window matches Stripe's; long enough that an agent that
crashes overnight and resumes the next morning can still safely
retry, short enough that the collection doesn't grow unbounded.

## MCP

Every `create_<path>` MCP tool accepts an optional `idempotencyKey`
argument. JSON-RPC over MCP doesn't carry per-call HTTP headers, so
the key travels in the tool argument:

```json
{
  "name": "create_account",
  "arguments": {
    "record": { "accountName": "Acme" },
    "idempotencyKey": "9f3c1c2e-..."
  }
}
```

Replays come back with `_idempotent_replay: true` on the result so
the agent can distinguish them from fresh creates.

## Recommended pattern for agents

```ts
import { randomUUID } from 'node:crypto';

async function safeCreate(payload) {
  const key = randomUUID();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch('/api/v1/account', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Idempotency-Key': key,        // NB: same key on every retry
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      return await r.json();
    } catch (transient) {
      if (attempt === 3) throw transient;
    }
  }
}
```

The key MUST be the same across retries of the same logical
operation, and MUST be different across different logical
operations. UUID v4 is a good default; any string the agent treats
as opaque works.

## Storage shape

Records live in the `idempotency_key` collection:

```json
{
  "key": "9f3c1c2e-...",
  "userId": "65b1...",
  "route": "POST /api/v1/account",
  "bodyHash": "5c6f...",
  "status": 201,
  "body": { "_id": "65b1...", "accountName": "Acme" },
  "headers": { "Content-Type": "application/json" },
  "expiresAt": "2026-05-11T...",
  "createdAt": "2026-05-10T..."
}
```

The `bodyHash` is SHA-256 over a **stable** stringification of the
effective post-filter body — keys sorted recursively, so
`{a:1,b:2}` and `{b:2,a:1}` produce the same hash. Arrays preserve
their order.

## TTL strictness

`expiresAt` is always queried with an explicit `> now()` filter, so
an expired row that the Mongo TTL monitor hasn't swept yet is
treated as if it didn't exist (and is opportunistically deleted).
The TTL is therefore a hard ceiling, not a "best-effort, with a
60-second tail" window.

## See also

- [Why agents come first](/concepts/agent-first/) — why retries-as-first-class is part of the design.
- [Errors](/reference/errors/) — the typed error codes the framework returns.
- [TypeScript client](/surfaces/client/) — the runtime sets `Idempotency-Key` for you when you pass `{ idempotencyKey }`.
