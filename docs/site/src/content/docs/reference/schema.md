---
title: Schema file shape
description: Complete reference for a schema file under schema/versions/v1/ — every key the loader recognises.
---

A schema file is a CommonJS module that exports a single plain
object. Drop one under `schema/versions/v1/`, and the loader builds
every surface from it. The loader walks each file once at boot
(and on every change in dev) — see
[Schema-driven generation](/concepts/schema-driven/) for the
mechanics.

## Minimum viable schema

```js
module.exports = {
  path: 'account',
  collection: 'account',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name',   type: String, required: true },
  ],
};
```

That's enough to mount REST routes, GraphQL types, MCP tools, and
Swagger fragments for `account`.

## Top-level keys

| Key | Type | Required | What it does |
|-----|------|----------|--------------|
| `path` | string | yes | URL segment under `/api/v1/<path>`, GraphQL prefix, MCP tool prefix. Must be unique across loaded schemas. |
| `collection` | string | yes | MongoDB collection name. Conventionally matches `path`. |
| `fields` | array | yes | Field definitions — see [Field options](/reference/fields/). |
| `relations` | object | no | Relation graph (`belongsTo` / `hasOne` / `hasMany`) consumed by `__include` and per-relation MCP tools. See [Relations](/features/relations/). |
| `aggregations` | array | no | Declarative aggregation pipelines that surface as REST + GraphQL + MCP. See [Aggregations](/features/aggregations/). |
| `compositeIndex` | array | no | Array of Mongo index specs. Plain key objects are unique (per-tenant uniqueness, e.g. `{ userId: 1, slug: 1 }`); use `{ fields: {...}, unique: false }` for a plain query index. |
| `softDelete` | boolean | no | Defaults to `true`. Set `false` to opt out of tombstones — DELETEs become hard-deletes. See [Soft delete](/features/soft-delete/). |
| `audit` | boolean | no | Defaults to `true`. Set `false` to skip audit log writes for this schema. See [Audit log](/features/audit/). |
| `acl` | object | no | Document-level role bypass slots (`list`, `delete`). See [ACL](/features/acl/). |
| `webhooks` | object | no | Outbound webhook subscriptions for create / update / delete events on this schema. See [Webhooks](/features/webhooks/). |
| `hooks` | object | no | Per-resource lifecycle hooks — `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. See [Lifecycle hooks](/features/hooks/). |
| `softDelete` | object | no | `{ retentionDays: N }` to auto-purge tombstoned rows after N days. Without it, tombstones live forever. See [Backup & retention](/operations/backup/). |
| `version` | string | no | Defaults to `v1`. Set when you want a single schema under a non-default version segment. |

Anything else on the top-level object is ignored — there's no
escape hatch for runtime config from the schema file. Code-level
extensions go in `app.js` (custom routes) or `utils/` (cross-cutting
helpers); see [Where to put new code](/reference/conventions/).

## `fields`

`fields` is an array (order matters for Swagger). Each entry is an
object — see [Field options](/reference/fields/) for the full
vocabulary. The two ownership fields — `userId` and `accountId` —
have special status: any schema can declare them, the framework
stamps them from the JWT, and clients can never supply them. See
[Tenant isolation](/concepts/tenancy/).

## `relations`

```js
relations: {
  // belongsTo: this schema holds the foreign key.
  account: { belongsTo: 'account', fk: 'accountId' },

  // hasMany: the OTHER schema holds the foreign key.
  contacts: { hasMany: 'contact', fk: 'accountId' },

  // hasOne: same as hasMany but at most one match.
  primaryAddress: { hasOne: 'address', fk: 'accountId', where: { isPrimary: true } },
}
```

| Key under each relation | Description |
|-------------------------|-------------|
| `belongsTo` / `hasOne` / `hasMany` | Exactly one of these names the target schema's `path`. |
| `fk` | Foreign key field. For `belongsTo`, it lives on this schema; for `hasOne` / `hasMany`, on the target. Defaults to `<target>Id`. |
| `where` | Optional filter applied to the target query. Useful for `hasOne` selection. |

`field.reference` is a legacy shorthand for `belongsTo`; new code
should prefer the `relations` map. See
[Relations](/features/relations/).

## `aggregations`

```js
aggregations: [
  {
    name: 'countByStage',
    description: 'Quote count grouped by stage for the authenticated user.',
    pipeline: [
      { $group: { _id: '$stage', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ],
    cache: { ttlSeconds: 30 },
    params: [
      { name: 'since', type: 'date', match: { createdAt: { $gte: '$since' } } },
    ],
  },
],
```

| Key | Description |
|-----|-------------|
| `name` | Unique within the schema. Becomes the URL segment and the GraphQL field. |
| `description` | Surfaces in `_describe` and Swagger. |
| `pipeline` | Mongo aggregation pipeline. The framework prepends `$match: { userId }` automatically — even `unsafe: true` aggregations cannot bypass tenant scoping. |
| `cache.ttlSeconds` | Optional in-process cache (per-tenant key). |
| `params` | Optional declarative inputs. Each becomes typed in `_describe`, the GraphQL args, and the MCP tool input schema. |
| `unsafe` | Set `true` to expose to operators with `acl.list` only. The tenant scope still applies. |

See [Aggregations](/features/aggregations/) for the param syntax.

## `compositeIndex`

Each entry is passed to Mongoose's `index()`. A plain key object is a
**unique** index — the common case, per-tenant uniqueness. To declare a
plain (non-unique) query index, use the long form with `unique: false`:

```js
compositeIndex: [
  { userId: 1, slug: 1 },          // per-tenant slug uniqueness (unique)
  { userId: 1, accountId: 1, year: 1, number: 1 }, // per-tenant invoice numbering (unique)
  { fields: { userId: 1, articleId: 1 }, unique: false }, // lookup index — many rows per pair
],
```

The long form accepts `unique: true` too (equivalent to the shorthand);
omitting the flag defaults to unique.

Always include `userId` (or `accountId` for the org variant) as the
first key — without it, a unique entry creates a global uniqueness
constraint that crosses tenants, and a query index won't serve the
tenant-scoped lookups the framework generates.

## `softDelete`

Default `true`. The framework adds a `deletedAt: Date` tombstone
field, rewrites every list / get query with `deletedAt: null`, and
turns DELETE into "set the tombstone." It also generates a
`POST /:id/restore` REST route, a `restore_<path>` MCP tool, and a
`<path>RemoveById` GraphQL mutation that respects the same.

```js
softDelete: false   // hard-delete on DELETE; no `deletedAt` field
```

See [Soft delete](/features/soft-delete/).

## `audit`

Default `true`. Every create / update / delete / restore /
state-machine transition writes a row to the `audit_log` collection
with before / after / diff projections. Reads come back as a
`history_<path>` MCP tool, a `historyByDoc` GraphQL field, and
`GET /:id/history` REST.

```js
audit: false   // no audit rows written; history endpoints absent
```

See [Audit log](/features/audit/).

## `acl`

Document-level bypass slots — opt operators in to see / delete
across tenants. Field-level ACL goes on the field, not here.

```js
acl: {
  list: ['admin', 'support'],
  delete: ['admin'],
},
```

See [ACL](/features/acl/).

## `webhooks`

```js
webhooks: {
  events: ['created', 'updated', 'deleted', 'transitioned'],
  endpoints: [
    { url: 'https://hooks.example.com/davepi', secret: 'whsec_...' },
  ],
}
```

The framework signs each delivery with HMAC-SHA256, retries with
exponential backoff, and emits an audit row per attempt. See
[Webhooks](/features/webhooks/).

## `hooks`

Per-resource lifecycle hooks — declare any subset:

```js
hooks: {
  beforeCreate: async ({ input, user, req, schema }) => input,
  afterCreate:  async ({ record, user, req, schema }) => {},
  beforeUpdate: async ({ input, current, user, req, schema }) => input,
  afterUpdate:  async ({ record, previous, user, req, schema }) => {},
  beforeDelete: async ({ current, user, req, schema }) => {},
  afterDelete:  async ({ record, user, req, schema }) => {},
}
```

`before*` hooks run synchronously, can mutate the persisted input
(return value replaces; `undefined` keeps), and throw to reject
through the centralised `errorHandler`. `after*` hooks run after
persistence and are best-effort — thrown errors are logged but
never fail the response. Coverage: REST `POST` / `PUT /:id` /
`DELETE /:id` and GraphQL `<path>CreateOne` / `<path>UpdateById` /
`<path>RemoveById`. **Bulk paths do not invoke hooks** — subscribe
a [plugin](/features/plugins/) to the event bus for bulk
reactions.

See [Lifecycle hooks](/features/hooks/).

## `softDelete: { retentionDays }`

```js
softDelete: { retentionDays: 30 }
```

Opt in to auto-purge of soft-deleted rows after N days. Without
this (and no `SOFT_DELETE_RETENTION_DAYS` env var), tombstones
live forever. Audit log and webhook delivery rows aren't
auto-purged at all — manual cron, see [Backup &
retention](/operations/backup/).

See [Backup & retention](/operations/backup/).

## What you can't do from a schema file

These are deliberate gaps — the schema file describes *data*, not
*runtime*:

- **Cross-cutting routes**: a route that spans schemas belongs in a [plugin](/features/plugins/) (or in `app.js` after the `schemas.forEach` loop for one-off framework-level routes).
- **Auth flows**: `routes/auth/` is hand-written.
- **Custom middleware**: `middleware/`.
- **Non-Mongo backends**: not supported. dAvePi is Mongo-only by design.

Per-resource side effects (validate before save, fire on create,
refuse delete) **do** belong on the schema — declare a `hooks`
block. See [Lifecycle hooks](/features/hooks/).

## See also

- [Field options](/reference/fields/) — every key inside a `fields[]` entry.
- [Conventions](/reference/conventions/) — naming, what to put where, what to avoid.
- [Tenant isolation](/concepts/tenancy/) — why `userId` is special.
