---
title: _describe manifest
description: One JSON endpoint that tells an agent every schema, field, relation, aggregation, state machine, and tool — agent-first capability discovery.
---

`GET /_describe` returns a compact JSON manifest of every loaded
schema — fields, relations, aggregations, file fields, ACL slots,
soft-delete / audit / search flags, REST endpoints, GraphQL
queries and mutations, MCP tools.

An agent landing on a fresh dAvePi can plan against the API in one
round-trip, before writing a line of integration code. No
swagger.json bloat, no "we need three queries to figure out what's
here."

## Why not Swagger?

Swagger 2.0 is what the framework also serves at
`/api-docs/swagger.json`, but it has gaps for agent-first use:

| | Swagger 2.0 | `_describe` |
|-|---------------|-------------|
| Size | Large — full path matrix per resource. | Compact — feature flags + per-schema metadata. |
| Format | Swagger 2.0. | Custom, but documented and stable. |
| Relations | Untyped — just an `accountId: string` field. | First-class — `relations: { contacts: { hasMany, fk } }`. |
| State machines | Untyped — just an `enum`. | First-class — `stateMachines: { status: { initial, states, transitions } }`. |
| Aggregations | Each is a path with hand-typed params. | First-class — `aggregations: [{ name, params }]`. |
| ACL slots | Absent. | Present — `acl: { list: ['admin'] }`. |
| Idempotency support | Absent. | Per-route flag. |
| MCP tools | Absent. | Per-schema list. |

For an agent that needs to plan, `_describe` is the right map.

## Shape

```json
{
  "version": "v1",
  "features": {
    "softDelete": true,
    "audit": true,
    "search": true,
    "files": true,
    "relations": true,
    "aggregations": true,
    "idempotency": true,
    "stateMachines": true,
    "webhooks": true
  },
  "schemas": [
    {
      "path": "account",
      "collection": "account",
      "softDelete": true,
      "audit": true,
      "fields": [
        { "name": "userId", "type": "String", "required": true, "stamped": true },
        { "name": "name", "type": "String", "required": true, "searchable": true },
        { "name": "isActive", "type": "Boolean", "computed": true }
      ],
      "relations": {
        "contacts": { "kind": "hasMany", "target": "contact", "fk": "accountId" }
      },
      "aggregations": [
        {
          "name": "countByRegion",
          "params": [{ "name": "since", "type": "date" }]
        }
      ],
      "stateMachines": {},
      "fileFields": [],
      "acl": { "list": ["admin"] },
      "endpoints": {
        "rest": [
          { "method": "POST",   "path": "/api/v1/account", "idempotent": true },
          { "method": "GET",    "path": "/api/v1/account" },
          { "method": "GET",    "path": "/api/v1/account/:id" },
          { "method": "PUT",    "path": "/api/v1/account/:id" },
          { "method": "DELETE", "path": "/api/v1/account/:id" },
          { "method": "POST",   "path": "/api/v1/account/:id/restore" }
        ],
        "graphql": {
          "queries":   ["accountById", "accountMany", "accountSearch", "accountCountByRegion"],
          "mutations": ["accountCreateOne", "accountUpdateById", "accountRemoveById", "accountRestore"]
        },
        "mcp": [
          "list_account", "get_account", "create_account", "update_account",
          "delete_account", "restore_account", "search_account",
          "list_account_contacts", "aggregate_account_countByRegion"
        ]
      }
    }
  ],
  "auth": {
    "endpoints": {
      "register": "/register",
      "login":    "/login"
    },
    "tokenType": "Bearer",
    "tokenTtl":  "2h"
  }
}
```

## Auth

`_describe` is **public** by default — it carries shape, not data.
Knowing that an `account` resource exists doesn't compromise any
particular tenant's data; an agent still needs a valid JWT to
make calls.

If you want it gated, wrap with `auth(true)` in `app.js`:

```js
app.use('/_describe', auth(true), describeRouter);
```

## Stable contract

The `_describe` shape is part of dAvePi's stable contract — the
framework versions it via `version` and treats breaking changes
the same as a major-version bump. Field flags can be added without
breaking consumers, but the existing keys' meanings won't change.

## Use cases

| Use case | Why `_describe` |
|----------|-----------------|
| Agent landing on a fresh project | One round-trip to plan against. |
| Admin SPA bootstrap | The shipped Refine admin reads `_describe` at startup. |
| TypeScript client generation | `davepi gen-client` walks the schema map directly, but a remote variant could read `_describe` if you'd rather pull live. |
| Custom dashboards | "Render a form for resource X" needs schema metadata; this is the source. |
| Documentation tooling | Generated docs / SDKs / wrappers can pull from one endpoint. |

## See also

- [Why agents come first](/concepts/agent-first/) — discovery before code.
- [REST API](/surfaces/rest/) — the routes `_describe` enumerates.
- [TypeScript client](/surfaces/client/) — same source of truth, compile-time.
