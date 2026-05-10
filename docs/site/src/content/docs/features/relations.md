---
title: Relations
description: Declarative belongsTo / hasOne / hasMany — populated in batched queries via __include, with tenant scoping re-applied on every traversal.
---

A `relations` map tells the framework how schemas link to each
other. The relations engine compiles the map at load and serves
populated children on demand via the `__include` query parameter
(REST), the equivalent GraphQL nested field, or the per-relation
MCP tool — all in batched queries with tenant scoping re-applied.

## Declaring relations

```js
// schema/versions/v1/account.js
module.exports = {
  path: 'account',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name',   type: String, required: true },
  ],
  relations: {
    contacts: { hasMany: 'contact', fk: 'accountId' },
    primaryContact: {
      hasOne: 'contact',
      fk: 'accountId',
      where: { isPrimary: true },
    },
  },
};

// schema/versions/v1/contact.js
module.exports = {
  path: 'contact',
  fields: [
    { name: 'userId',    type: String, required: true },
    { name: 'accountId', type: String, required: true },
    { name: 'name',      type: String, required: true },
    { name: 'isPrimary', type: Boolean, default: false },
  ],
  relations: {
    account: { belongsTo: 'account', fk: 'accountId' },
  },
};
```

| Kind | What it means | Where the FK lives |
|------|---------------|--------------------|
| `belongsTo` | This schema points at one record in the target. | On *this* schema. |
| `hasOne` | The target schema has a single matching record. | On the *target*. |
| `hasMany` | The target schema has multiple matching records. | On the *target*. |

`fk` defaults to `<target>Id` (e.g. `accountId` for a relation
targeting `account`). `where` is an optional filter applied to the
target query — useful for `hasOne` to pick "the primary one."

## REST: `__include`

```http
GET /api/v1/account/abc?__include=contacts,primaryContact
```

Returns:

```json
{
  "_id": "abc",
  "name": "Acme",
  "contacts": [
    { "_id": "x", "name": "Jane", "accountId": "abc" },
    { "_id": "y", "name": "Bob",  "accountId": "abc" }
  ],
  "primaryContact": { "_id": "x", "name": "Jane", "isPrimary": true }
}
```

Multiple includes in one query: `?__include=contacts,primaryContact`.

## Batching: O(1) per relation

The engine collects all parent IDs in the response, then issues
one find per relation, then bucket-maps the children back. A list
of 100 accounts with `?__include=contacts` is two queries —
`account` then `contact` — not 101.

## Tenant isolation re-applied

Every related query re-applies `userId: req.user.user_id` against
the target collection, **even though** the parent's tenancy was
already verified at the top of the request. Why: a cross-collection
`_id` could theoretically belong to another tenant if the parent's
FK was tampered with at write time. We never trust the parent
record's tenancy alone. See [Tenant isolation](/concepts/tenancy/).

## Soft-delete tombstones

Tombstones are filtered from relations regardless of the parent's
`__includeDeleted` flag. `deletedAt: null` matches both null and
missing fields, so the same query is correct against soft-delete-
enabled and soft-delete-disabled targets.

## ACL projection

Each populated record is run through the target schema's ACL
projector. A user who can read `account` but cannot read
`contact.privateNotes` doesn't get `privateNotes` leaked sideways
through `__include=contacts`.

## GraphQL

Same relations surface as nested fields:

```graphql
{
  accountById(_id: "abc") {
    name
    contacts { _id, name }
    primaryContact { _id, name }
  }
}
```

The wrappers in `utils/scopeResolver.js` re-apply `userId` on each
nested resolution.

## MCP

Per-relation tools surface automatically:

| Relation kind | Generated tool |
|---------------|----------------|
| `belongsTo` / `hasOne` | `get_<path>_<rel>(id)` — returns the single populated record (or null). |
| `hasMany` | `list_<path>_<rel>(id, filter?, sort?)` — returns the populated children for that parent. |

## TypeScript client

```ts
const account = await api.account.get('abc', { include: ['contacts'] });
// account.contacts is typed as Contact[]

const contacts = await api.account.contacts('abc');
// shorthand for the per-relation MCP-equivalent
```

The `<Resource>Include` type is a literal union — `'contacts' | 'primaryContact'` —
so the compiler catches misspelled relation names.

## Depth cap

`__include=tasks.subtasks` (nested) is not supported in v1. Each
include is one hop; combine multiple top-level includes if you need
breadth. Two-hop includes are a follow-up.

## Legacy: `field.reference`

The older shorthand still works:

```js
{ name: 'accountId', type: String, reference: 'account' }
```

This is preserved as a synthetic `belongsTo` so existing schemas
keep working — but the populated value goes onto the FK field name
itself only when explicitly opted in via `__include`. New code
should declare a `relations` map for the named accessor and the
generated MCP tools.

## See also

- [Schema file shape](/reference/schema/#relations) — top-level relation syntax.
- [Tenant isolation](/concepts/tenancy/) — why each related query re-applies `userId`.
- [ACL](/features/acl/) — projection on populated records.
