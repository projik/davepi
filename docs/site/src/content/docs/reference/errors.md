---
title: Errors
description: Every typed error code dAvePi returns, with HTTP status, MCP isError shape, and TypeScript client DavepiError mapping.
---

dAvePi returns a stable error envelope across every surface:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Validation failed: amount: Path `amount` is required.",
    "details": { /* per-code, see below */ }
  }
}
```

| Surface | How it surfaces |
|---------|------|
| REST | Response body, with the appropriate HTTP status. |
| GraphQL | `errors[0].message` + `errors[0].extensions.code` and `errors[0].extensions.details`. |
| MCP | `{ isError: true, content: [{ type: 'text', text: <serialized error JSON> }] }`. |
| Typed client | Thrown as `DavepiError`: `{ status, code, message, details? }`. |

`code` is the part to read in code. `message` is for humans —
agents should branch on `code`.

## Error catalogue

| Code | HTTP | Recoverable? | When |
|------|------|--------------|------|
| `VALIDATION` | 400 | yes | Mongoose / framework validation failed. `details` carries the per-field reasons. |
| `INVALID_ID` | 400 | yes | A path param looks like an ObjectId but isn't valid. |
| `INVALID_TRANSITION` | 400 | yes | A state-machine field was set to a value not declared in `transitions[current]`. `details` carries `field`, `current`, `attempted`, `allowed`. |
| `UNAUTHORIZED` | 401 | usually | Missing / invalid / expired Bearer token. The MCP variant carries `auth: true` so clients can refresh. |
| `FORBIDDEN` | 403 | no | Caller has a valid token but lacks the role for this action (e.g. trying to use an `unsafe: true` aggregation without `acl.list`). |
| `NOT_FOUND` | 404 | no | Resource doesn't exist for this caller. **Note**: cross-tenant reads also return 404, not 403 — we don't disclose existence to the wrong tenant. |
| `METHOD_NOT_ALLOWED` | 405 | no | Verb not supported on this path. |
| `CONFLICT` | 409 | no | Generic conflict. |
| `DUPLICATE` | 409 | sometimes | Mongo unique-index violation. `details` carries the duplicate field. Recoverable if the agent can pick a different value. |
| `IDEMPOTENCY_CONFLICT` | 409 | no | `Idempotency-Key` was reused with a different request body. The agent should pick a new key. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes | Concurrent retry hit while the first call was still running. Wait briefly and retry under the same key. |
| `RATE_LIMITED` | 429 | yes | Rate limiter tripped. Retry after the `Retry-After` header. |
| `INTERNAL` | 500 | no | Unknown error. In production, `message` is reduced to `"Internal server error"` deliberately — the real error is in the server log under the request's `reqId`. |

The `recoverable` column is what the framework sets on the MCP
error payload. Agents should retry recoverable errors after fixing
their input; non-recoverable errors are a structural mismatch
(wrong tenant, wrong role, etc.).

## `details` per code

### `VALIDATION`

```json
{
  "details": {
    "fields": {
      "amount":   "Path `amount` is required.",
      "stage":    "`won` is not a valid enum value for path `stage`."
    }
  }
}
```

### `INVALID_TRANSITION`

```json
{
  "details": {
    "field":     "status",
    "current":   "review",
    "attempted": "archived",
    "allowed":   ["approved", "rejected"]
  }
}
```

### `DUPLICATE`

```json
{
  "details": {
    "field": "slug",
    "value": "acme"
  }
}
```

### `IDEMPOTENCY_CONFLICT`

```json
{
  "details": {
    "originalBodyHash": "5c6f...",
    "submittedBodyHash": "8a3e..."
  }
}
```

### `RATE_LIMITED`

```json
{
  "details": {
    "retryAfterSeconds": 30
  }
}
```

The HTTP response also carries a `Retry-After` header — both are
populated.

## Production reduction

In production (`NODE_ENV=production`), unknown errors (anything
that isn't an `AppError` subclass) are reduced to:

```json
{ "error": { "code": "INTERNAL", "message": "Internal server error" } }
```

The actual error is logged at error level with the request's
`reqId`, so an operator can correlate the response with the log
line. **Do not** write `res.status(500).send(err.message)` — that
leaks stack traces and internal paths to the wire.

## Throwing typed errors from custom routes

```js
const { NotFoundError, ValidationError } = require('./utils/errors');

app.get('/api/v1/foo/:id/custom', auth(true), asyncHandler(async (req, res) => {
  const doc = await Foo.findOne({ _id: req.params.id, userId: req.user.user_id });
  if (!doc) throw new NotFoundError('foo');
  if (!doc.canFrobnicate) throw new ValidationError('foo cannot be frobnicated');
  // ...
}));
```

`asyncHandler` forwards the rejection to the terminal
`errorHandler`, which formats the envelope. Don't write the
envelope yourself — the formatter ensures consistency with every
auto-generated route.

## See also

- [Idempotency keys](/features/idempotency/) — `IDEMPOTENCY_CONFLICT` / `IDEMPOTENCY_IN_PROGRESS`.
- [State machines](/features/state-machines/) — `INVALID_TRANSITION` payload.
- [Why agents come first](/concepts/agent-first/) — why typed codes matter.
