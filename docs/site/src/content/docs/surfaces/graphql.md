---
title: GraphQL API
description: Apollo Server v5 with auto-generated types and resolvers from every schema, every resolver wrapped for tenant scoping.
---

Apollo Server v5 (`@apollo/server` + `@as-integrations/express4`) ships
out of the box at `/graphql/`. The framework
walks the schema registry once at boot (and on every change in
dev), composes a Mongoose-derived TC per schema via
`graphql-compose-mongoose`, wraps every resolver in
`utils/scopeResolver.js`, and serves the result.

## What gets generated per schema

For schema `path: 'account'`:

| Operation | Resolver name |
|-----------|---------------|
| Find one by id | `accountById(_id)` |
| Find many by ids | `accountByIds(_ids)` |
| Find one by filter | `accountOne(filter, sort)` |
| Find many by filter | `accountMany(filter, sort, limit, skip)` |
| Count | `accountCount(filter)` |
| Connection (Relay) | `accountConnection(filter, ...)` |
| Pagination | `accountPagination(filter, page, perPage)` |
| Search | `accountSearch(q, filter, sort)` (when any field is `searchable`) |
| History | `accountHistory(_id)` (audit-enabled schemas) |
| Aggregations | `account<Aggregation>(args)` per declared aggregation |
| Create one | `accountCreateOne(record)` |
| Create many | `accountCreateMany(records)` |
| Update by id | `accountUpdateById(_id, record)` |
| Update one by filter | `accountUpdateOne(filter, record)` |
| Update many by filter | `accountUpdateMany(filter, record)` |
| Remove by id | `accountRemoveById(_id)` |
| Remove many | `accountRemoveMany(filter)` |
| Restore | `accountRestore(_id)` (soft-delete-enabled schemas) |
| Transition | `<path>Transition<Field>(_id, to)` per state-machine field — `to` is typed as the schema's generated enum |

## Tenant scoping is structural

Every resolver is wrapped via the helpers in `utils/scopeResolver.js`:

| Wrapper | Use for |
|---------|---------|
| `wrapFilter` | Read-many resolvers (`Many`, `Connection`, `Pagination`, `Count`, `Search`). |
| `wrapFindById` / `wrapFindByIds` | Read-by-id resolvers. |
| `wrapCreateOne` / `wrapCreateMany` | Create resolvers — stamps `userId` / `accountId`. |
| `wrapByIdMutation` | Update / remove / restore by id. |

`userId: ctx.user.user_id` is injected into the filter before the
resolver runs. **If you write a custom resolver, wrap it.** Going
direct to a Mongoose model bypasses tenant scoping.

```js
const { wrapFilter } = require('./utils/scopeResolver');

tc.addResolver({
  name: 'accountsWithDeals',
  resolve: wrapFilter(
    { schema, kind: 'read' },
    async (rp, ctx) => {
      // rp.args.filter has userId injected; query freely.
    }
  ),
});
```

## Input types: writable vs full

Three input types per schema, generated automatically:

| Type | Excludes |
|------|----------|
| `<Path>Input` | Computed fields, file fields, server-stamped fields (`userId`/`accountId`). Used for `CreateOne`. |
| `<Path>UpdateInput` | Same exclusions, plus all required fields are nullable. Used for partial updates. |
| `<Path>FilterInput` | All readable fields, with mongo-querystring operators. |

Input types deliberately omit ownership fields so a client can't
supply them — the wrappers stamp them server-side.

## Auth

Bearer JWT — exactly the same as REST. The context resolver (passed to
`expressMiddleware`, not the server constructor, in v4+) picks up
`Authorization: Bearer ...`, verifies it against `TOKEN_KEY`, and
exposes `ctx.user` with `{ user_id, email, roles }`.

```js
// Apollo Server v4+ takes the (async) context resolver on the Express
// integration rather than the ApolloServer constructor.
app.use('/graphql', expressMiddleware(server, {
  context: async ({ req }) => ({
    user: req.user,   // populated by auth middleware
    // ... other things resolvers might need
  }),
}));
```

Resolvers without auth context are rejected before they run via
`wrapFilter`'s built-in check.

## Soft delete

GraphQL list resolvers honour the same `deletedAt: null` predicate
as REST. To include tombstones, pass `_includeDeleted: true` on the
`Many` / `One` / `Count` resolvers — same flag as `__includeDeleted`
on the REST surface.

`accountRemoveById` performs a soft-delete by default.
`accountRestore` clears the tombstone. `accountRemoveOne` /
`RemoveMany` follow the same pattern.

## Relations

Relations declared in the schema's `relations` map appear as
nested fields:

```graphql
{
  accountById(_id: "abc") {
    name
    contacts(filter: { /* ... */ }) {
      _id, name
    }
    primaryContact { _id, name }
  }
}
```

`hasMany` relations accept a filter argument; `hasOne` /
`belongsTo` are scalar.

## State machines

State-machine fields surface as a literal `enum` in the GraphQL
output type, plus a dedicated transition mutation per field. The
mutation runs the same validate / persist / audit / event /
`onEnter` pipeline as the REST PUT path, and `to` is typed as the
schema's generated enum so a typo on the wire is caught before
any handler runs:

```graphql
mutation {
  quoteTransitionStatus(_id: "abc", to: approved) {
    record {
      _id
      status                       # enum value
      availableTransitions {
        status                     # [String!]
      }
    }
  }
}
```

Updating the state-machine field through the standard
`<path>UpdateById` resolver also validates against the
state machine — the dedicated transition mutation is the
preferred call shape, but a regular update can't bypass the
transition graph.

`INVALID_TRANSITION` errors carry the structured payload in
`errors[0].extensions` for clients to react to.

## Hot reload

Apollo Server v3 builds its schema at construction time — there's
no "swap the schema" API. The framework solves it with an
indirection middleware: the parent app holds a pointer the loader
can swap on rebuild. In-flight requests hit the previous router;
new requests hit the new one. See
[Hot reload](/concepts/hot-reload/).

## Playground

In dev (`NODE_ENV !== 'production'`), the GraphQL playground is
mounted at `/graphql/`. Introspection is also gated on dev.

In production, both are off. If you need GraphQL introspection in
production, override the `introspection` flag in `app.js`.

## See also

- [REST API](/surfaces/rest/) — same surface, REST shape.
- [Relations](/features/relations/) — nested-field semantics.
- [Tenant isolation](/concepts/tenancy/) — why every resolver is wrapped.
- [Hot reload](/concepts/hot-reload/) — the indirection-middleware pattern.
