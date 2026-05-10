---
title: Aggregations
description: Declarative Mongo aggregation pipelines that surface as REST, GraphQL, and MCP — with auto-injected tenant scope and optional caching.
---

Schemas can declare aggregation pipelines that surface as a REST
route, a GraphQL field, an MCP tool, and a typed client method —
the same source-of-truth pattern as the rest of the framework. The
aggregation runner prepends `$match: { userId }` automatically, so
even the most freeform pipeline can't return cross-tenant rows.

## Declaring an aggregation

```js
module.exports = {
  path: 'quote',
  fields: [/* ... */],
  aggregations: [
    {
      name: 'countByStage',
      description: 'Quote count grouped by stage for the authenticated user.',
      pipeline: [
        { $group: { _id: '$stage', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ],
    },
  ],
};
```

The framework adds:

- `GET /api/v1/quote/aggregations/countByStage` (REST)
- `quoteCountByStage` GraphQL query
- `aggregate_quote_countByStage` MCP tool
- `api.quote.countByStage()` on the typed client

Every entry surfaces in `_describe` so an agent can plan against
it without reading source.

## Tenant scope is non-bypassable

The runner prepends `$match: { userId: req.user.user_id }` as the
first stage of every aggregation. Even if you write
`{ $match: {} }` as your first stage, the framework's stage runs
first — your stage filters the already-scoped result.

```js
pipeline: [
  // Framework injects $match: { userId } here, ahead of you.
  { $group: { _id: '$stage', count: { $sum: 1 } } },
],
```

Schema authors don't have to think about it — they write the
business logic and tenancy is structural.

## Parameters

```js
aggregations: [
  {
    name: 'wonByMonth',
    description: 'Won quote count by month, optionally filtered to a date range.',
    params: [
      { name: 'since', type: 'date', required: true,
        match: { closedAt: { $gte: '$since' } } },
      { name: 'until', type: 'date',
        match: { closedAt: { $lte: '$until' } } },
    ],
    pipeline: [
      { $match: { stage: 'won' } },
      { $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$closedAt' } },
          count: { $sum: 1 },
      } },
      { $sort: { _id: 1 } },
    ],
  },
],
```

| Param key | Description |
|-----------|-------------|
| `name` | Argument name on the URL / GraphQL / MCP. |
| `type` | One of `'string'` / `'number'` / `'date'` / `'boolean'`. The framework parses the wire value into the typed form. |
| `required` | Boolean — server returns 400 if the caller omits it. |
| `default` | Default value if the caller omits a non-required param. |
| `match` | Mongo predicate pasted into a `$match` stage; `'$<paramName>'` placeholders are replaced with the parsed value. |

Each declared `match` becomes its own `$match` stage in the
compiled pipeline, ordered after the tenant-scope match and before
your hand-written pipeline.

## Caching

```js
aggregations: [
  {
    name: 'countByStage',
    pipeline: [/* ... */],
    cache: { ttlSeconds: 30 },
  },
],
```

The cache is in-process and per-tenant — the cache key includes
`userId` so users don't share buckets. It's a hot-path optimization
for dashboards, not a substitute for materialized views. Drop the
key when you want strict freshness.

The framework purges a tenant's cache entry when any record on
this schema is created / updated / deleted, so a "won" deal
immediately moves the dashboard counter.

## Surfaces

### REST

```http
GET /api/v1/quote/aggregations/wonByMonth?since=2026-01-01
Authorization: Bearer <token>

200 OK
{
  "results": [
    { "_id": "2026-01", "count": 3 },
    { "_id": "2026-02", "count": 7 }
  ]
}
```

### GraphQL

```graphql
{
  quoteWonByMonth(since: "2026-01-01") {
    _id
    count
  }
}
```

### MCP

```json
{
  "name": "aggregate_quote_wonByMonth",
  "arguments": { "since": "2026-01-01" }
}
```

### Typed client

```ts
const rows = await api.quote.wonByMonth({ since: '2026-01-01' });
```

## Cross-tenant operators

If an operator role legitimately needs to see across tenants — an
admin running platform-wide reporting, say — they need an
escape hatch. Set `unsafe: true` on the aggregation and pair it
with the schema's `acl.list` slot:

```js
acl: { list: ['admin'] },
aggregations: [
  {
    name: 'platformWonByMonth',
    unsafe: true,
    pipeline: [
      { $match: { stage: 'won' } },
      { $group: { /* across all tenants */ } },
    ],
  },
],
```

`unsafe: true` skips the auto-injected `$match: { userId }`. Only
callers whose role is in `acl.list` can invoke the unsafe
aggregation; everyone else gets `403 FORBIDDEN`. **Use sparingly.**

## See also

- [Schema file shape](/reference/schema/#aggregations) — top-level syntax.
- [Tenant isolation](/concepts/tenancy/) — why the `$match: { userId }` stage matters.
- [ACL](/features/acl/) — `acl.list` for cross-tenant operators.
