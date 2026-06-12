---
title: Tenant isolation
description: How dAvePi guarantees that User A never sees User B's records, across every surface.
---

Tenant isolation is the framework's most important invariant. Every
read scopes by the authenticated user; every write stamps the user;
every relation re-applies the scope. Breaking this would be a
critical security bug — the framework treats it as non-bypassable.

## The contract

Every schema has a required `userId` field. When a user creates a
record, the framework stamps `userId` from their JWT — clients never
supply it. When a user reads a record, the framework filters by
`userId`. When a relation traverses to a child, the child query
*also* filters by `userId`.

That field is **mandatory and enforced**. The framework stamps the
value, but the Mongoose model only carries the paths you declare — so
a schema that omits `userId` would have its stamp silently dropped by
Mongoose's strict mode at `create()`, producing an ownerless record.
To keep the invariant unbreakable, the schema loader refuses to load
any schema whose `fields` don't declare a persisted `userId`, failing
loud at boot rather than leaking across tenants.

```
JWT issued at /login
    ↓
{ user_id: "abc..." }   ← signed, server-verified
    ↓
auth(true) middleware
    ↓
req.user.user_id available everywhere downstream
    ↓
Every Mongoose query: { ...filter, userId: req.user.user_id }
```

## Where it's enforced

| Surface | Enforcement site |
|---------|------------------|
| REST POST | `utils/schemaLoader.js` create handler stamps `userId` from `req.user.user_id` after `filterWritable` runs. |
| REST GET (list / single) | The Mongo filter has `userId: req.user.user_id` injected before the find. |
| REST PUT (single / bulk) | Same — the ownership query carries `userId` (unless the schema's `acl.write` grants a cross-tenant update; see below). Bulk PUT always forces `userId` into the upsert filter and is never bypassed. |
| REST DELETE | Same. |
| GraphQL | `wrapFilter` / `wrapByIdMutation` / `wrapFindById` in `utils/scopeResolver.js` inject `userId` into `rp.args.filter` before the resolver runs. |
| MCP | Tool handlers go through the same Mongoose models with the same scoping. |
| Aggregations | `runAggregation` prepends `$match: { userId }` as the first pipeline stage — even `unsafe: true` aggregations can't return cross-tenant rows. |
| Relations (`__include`) | Each related query re-applies `userId` against the target collection — see [Relations](/features/relations/). |

## ACL: bypass slots for read-many / update / delete

Some operators need to reach across tenants — admin staff, customer
support, etc. A schema can opt in:

```js
module.exports = {
  path: 'order',
  fields: [...],
  acl: {
    list: ['admin'],     // these roles see all rows on list / findMany
    write: ['admin'],    // these roles can update records they don't own
    delete: ['admin'],   // these roles can delete records they don't own
  },
};
```

The `write` slot is how an admin edits a customer-owned record. It
bypasses the `userId` filter on every update surface: REST
`PUT /:id`, GraphQL `UpdateById` / `UpdateOne` / `UpdateMany` and the
state-machine transition mutations, and MCP `update_<path>` — but
**ownership never moves**: the framework still strips `userId` /
`accountId` from the update payload, so the record stays owned by its
original tenant and field-level `acl.update` still applies. There's no
`create` bypass (create always stamps ownership from the JWT), and the
bulk `PUT /<path>` upsert stays owner-only because its filter doubles
as the insert seed.

Field-level ACL is also supported:

```js
{ name: 'salary', type: Number, acl: { read: ['admin', 'hr'] } }
```

`projectByAcl` strips the field from responses for callers without an
overlapping role. The same projection runs on webhook payloads and on
audit-log diffs — there's no side channel that bypasses ACL.

## Two sentinel fields

Every schema receives `userId` and `accountId` stamped from the JWT.
For most projects these are the same value (single-user-per-tenant).
For multi-org models, treat `userId` as identity and `accountId` as
tenant; use a custom relation field (e.g. `parentAccountId`) for
record-level FKs.

## Why a custom FK should not be `accountId`

The framework stamps `accountId` automatically on every record from
the JWT. If you also use `accountId` as a foreign key, your client's
supplied value gets clobbered by the stamping pass. Name custom FKs
something else (`parentAccountId`, `orgId`, etc.) — every starter
template follows this convention.

## What an attack would look like

Without tenant scoping, a User A could:
- Pass `{ userId: 'b' }` in a POST body to plant a record under User B.
- Pass a User B record's `_id` to GET / PUT / DELETE.
- Use `__include=tasks` to read User B's child records via User A's parent.
- Use a GraphQL mutation `accountUpdateMany(filter: {})` to update every record.

Every one of these is closed:

- POST: `userId` is stamped server-side, ignoring any client value.
- GET / PUT / DELETE by id: filter includes `userId`, so a borrowed `_id` returns 404.
- `__include`: the related query re-applies `userId`.
- GraphQL bulk: `wrapFilter` injects `userId` into the filter.

These closures are the default for **every** caller. The only way to
reach across tenants is to be explicitly granted a document-level ACL
bypass — `acl.list` (read), `acl.write` (update), `acl.delete`
(delete) — on that specific schema. A role granted such a slot *is*
trusted to operate cross-tenant, so for it the corresponding bulk
mutation is intentionally open: an `acl.write` role can run
`accountUpdateMany(filter: {})` to update every record, exactly as an
`acl.delete` role can run `accountRemoveMany(filter: {})` to delete
every record. That's the point of the slot, not a leak — grant it only
to operator roles, and never to the default `user` role. (Ownership
still never moves: tenant fields stay stamped from the JWT even under
a write bypass.)

The test suite has cross-tenant isolation tests for every surface
(REST, GraphQL, MCP, relations, aggregations) — they're a structural
guarantee against regressions.
