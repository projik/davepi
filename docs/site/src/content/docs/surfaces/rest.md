---
title: REST API
description: Auto-generated CRUD plus aggregations, file routes, restore, history, search — every schema gets the same shape.
---

dAvePi mounts a per-schema Express router for every loaded schema.
The shape is identical across resources — once you know it for
`account`, you know it for everything else.

## Routes per schema

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/<path>` | Create. `userId` / `accountId` stamped from JWT. Optional `Idempotency-Key` header. |
| `GET` | `/api/v1/<path>` | List. Pagination + filter + sort + `__include` + `q` + `__includeDeleted`. |
| `PUT` | `/api/v1/<path>` | Bulk upsert. Filter + record body; ownership pinned to JWT. |
| `GET` | `/api/v1/<path>/:id` | Read one. Same `__include` set as list. |
| `PUT` | `/api/v1/<path>/:id` | Partial update. State-machine fields validated against `transitions[current]`. |
| `DELETE` | `/api/v1/<path>/:id` | Soft-delete (or hard, with `softDelete: false`). |
| `POST` | `/api/v1/<path>/:id/restore` | Clear `deletedAt`. Soft-delete schemas only. |
| `POST` | `/api/v1/<path>/:id/transition` | Action route for state-machine transitions: `{ field, to }`. |
| `GET` | `/api/v1/<path>/:id/history` | Audit log for the record, newest first. Audit-enabled schemas only. |
| `GET` | `/api/v1/<path>/aggregations/<name>` | Run a declared aggregation. |
| `POST` | `/api/v1/<path>/:id/<file-field>` | Upload (multipart). |
| `GET` | `/api/v1/<path>/:id/<file-field>` | Fetch metadata + URL. |
| `DELETE` | `/api/v1/<path>/:id/<file-field>` | Delete the blob and clear the meta. |
| `GET` | `/api/v1/<path>-schema` | The framework-introspection JSON for this schema. |

## Auth

Bearer JWT on every authenticated route:

```http
Authorization: Bearer <token>
```

Token is issued by `POST /login` (see [Quickstart](/quickstart/)).
The framework reads `user_id` and `roles` from the verified token;
clients never supply either.

## Pagination

Three knobs on every list endpoint:

| Param | Default | Description |
|-------|---------|-------------|
| `__page` | `1` | 1-indexed page number. |
| `__sort` | `createdAt:desc` (or `score` when `q` is set) | `field:asc` / `field:desc` / `score`. Multiple comma-separated. |
| `__perPage` | `PAGE_SIZE` env (default 20) | Capped at 200. |

Response shape:

```json
{
  "results":     [/* docs */],
  "totalResults": 142,
  "page":         1,
  "perPage":      20,
  "totalPages":   8,
  "nextPage":     2,
  "prevPage":     null
}
```

## Filtering: mongo-querystring

Filters use mongo-querystring conventions on the URL — the same
operators Mongo accepts, JSON-encoded for object values:

```http
GET /api/v1/contact?accountId=abc
GET /api/v1/contact?createdAt={"$gte":"2026-01-01"}
GET /api/v1/contact?name={"$regex":"^Ja","$options":"i"}
```

| Operator | Form |
|----------|------|
| Equality | `field=value` |
| Comparison | `field={"$gt": ...}` (or `$gte`, `$lt`, `$lte`, `$ne`) |
| In list | `field={"$in": ["a","b"]}` |
| Regex | `field={"$regex": "...", "$options": "i"}` |

Sub-objects MUST be JSON-encoded (URL-safe). The runtime in the
typed client does this for you.

## Relations: `__include`

```http
GET /api/v1/account/abc?__include=contacts,primaryContact
```

Comma-separated relation names from the schema's `relations` map.
See [Relations](/features/relations/).

## Search: `?q=`

```http
GET /api/v1/contact?q=jane
```

Available on schemas with at least one `searchable: true` field.
Default sort becomes `score`. See [Search](/features/search/).

## Soft-delete: `__includeDeleted`

```http
GET /api/v1/account?__includeDeleted=true
```

Returns tombstoned rows as well. Defaults to false. Relations
ignore this flag — they always filter tombstones. See
[Soft delete](/features/soft-delete/).

## Idempotency: `Idempotency-Key`

```http
POST /api/v1/account
Idempotency-Key: 9f3c-...
```

See [Idempotency keys](/features/idempotency/).

## Errors

Every typed error returns the same shape:

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Cannot transition status from 'review' to 'archived'",
    "details": {
      "current": "review",
      "attempted": "archived",
      "allowed": ["approved", "rejected"]
    }
  }
}
```

Codes are stable contracts. See [Errors](/reference/errors/).

## Rate limiting

Two limiters mount at boot:

| Path | Default | Override |
|------|---------|----------|
| `/api/*` | 600 req/min/IP | `RATE_LIMIT_API_PER_MIN` |
| `/login`, `/register` | 10 req/min/IP | `RATE_LIMIT_AUTH_PER_MIN` |

Both are skipped when `NODE_ENV=test` so the suite isn't tripped.
Rate-limited responses are `429` with `{ error: { code: 'RATE_LIMITED' } }`.

## CORS

Configured via `CORS_ORIGINS` (comma-separated allowlist). With no
value, no cross-origin requests are accepted — set it to
`http://localhost:3000,https://app.example.com` for the typical
admin SPA + production frontend setup.

## Swagger UI

Live at `/api-docs`. The JSON spec is at `/api-docs/swagger.json` —
useful as a Swagger 2.0 export when an external tool needs it. For
agent-friendly introspection, prefer
[`_describe`](/surfaces/describe/) — same data, smaller envelope,
first-class relations and state machines.

## See also

- [GraphQL](/surfaces/graphql/) — same surface, GraphQL shape.
- [MCP server](/surfaces/mcp/) — same surface, native tool calls.
- [TypeScript client](/surfaces/client/) — typed wrapper over REST.
- [\_describe](/surfaces/describe/) — agent-friendly capability manifest.
