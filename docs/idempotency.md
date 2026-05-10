# Idempotency keys

Agents (and humans) retry. A flaky network, a model timeout, a harness restart — and a `POST` that succeeded in flight gets re-sent, creating a duplicate record. Idempotency keys close that gap: a client tags each logical operation with a stable string, and the server guarantees the same operation runs at most once per key.

dAvePi implements the [Stripe-style](https://stripe.com/docs/api/idempotent_requests) contract on every auto-generated `POST` route, plus on every MCP `create_<path>` tool.

## REST: `Idempotency-Key` header

```http
POST /api/v1/account
Authorization: Bearer <token>
Idempotency-Key: 9f3c1c2e-...
Content-Type: application/json

{ "accountName": "Acme" }
```

The server returns the response with `201 Created` on the first call. A retry with the **same key + same body** returns the **same response**, with an extra header:

```http
Idempotency-Replay: true
```

So the agent can tell whether it actually ran the operation or just got a cached result.

## Conflict: same key, different body

If the same key is used with a different request body, the server rejects with `409 IDEMPOTENCY_CONFLICT`:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Idempotency-Key was reused with a different request body"
  }
}
```

This is the safe response: the server can't know whether the agent meant "retry the previous call" (in which case the body shouldn't change) or "new operation under a recycled key" (which is an agent bug). Refusing to do anything is correct.

## Scoping rules

Keys are scoped per `(key, user, route)`:

- **Per user**: User A and User B can use the same key without colliding.
- **Per route**: the same key on `POST /api/v1/account` and `POST /api/v1/contact` does not deduplicate across routes.
- **Per body hash**: same `(key, user, route)` with a changed body → 409.

The unique index on `{ key, userId, route }` enforces this at the storage layer.

## What is and isn't cached

- **2xx responses**: cached for the configured TTL.
- **Non-2xx responses**: NOT cached. An agent that posted a malformed payload, got a `400 VALIDATION`, then fixed the payload and retried with the **same key** will see the corrected request go through. We don't trap agents in their own mistakes.
- **No header**: middleware is a no-op. Existing clients that don't set `Idempotency-Key` see exactly the previous behaviour.

## TTL

Default 24 hours. Override via `IDEMPOTENCY_TTL_SECONDS` in `.env`. MongoDB's TTL monitor sweeps expired records automatically on its background cycle (~60s cadence).

A 24h window matches Stripe's; long enough that an agent that crashes overnight and resumes the next morning can still safely retry, short enough that the collection doesn't grow unbounded.

## MCP

Every `create_<path>` MCP tool accepts an optional `idempotencyKey` argument. JSON-RPC over MCP doesn't carry per-call HTTP headers, so the key travels in the tool argument:

```json
{
  "name": "create_account",
  "arguments": {
    "record": { "accountName": "Acme" },
    "idempotencyKey": "9f3c1c2e-..."
  }
}
```

Replays come back with `_idempotent_replay: true` on the result so the agent can distinguish them from fresh creates.

## Recommended pattern for agents

```ts
// In your client wrapper:
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

The key MUST be the same across retries of the same logical operation, and MUST be different across different logical operations. UUID v4 is a good default; any string the agent treats as opaque works.

## Storage shape

Records live in the `idempotency_key` collection:

```json
{
  "key": "9f3c1c2e-...",
  "userId": "65b1...",
  "route": "POST /api/v1/account",
  "bodyHash": "5c6f...",
  "status": 201,
  "body": { "_id": "65b1...", "accountName": "Acme", ... },
  "headers": { "Content-Type": "application/json" },
  "expiresAt": "2026-05-11T...",
  "createdAt": "2026-05-10T..."
}
```

The `bodyHash` is SHA-256 over `JSON.stringify(body)` — canonicalised through stringify so two requests with the same logical payload but different key ordering still match.
