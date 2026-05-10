---
title: ACL
description: Role-based access control — document-level bypass slots and field-level read/create/update gates, applied symmetrically across REST, GraphQL, MCP, audit, and webhooks.
---

ACL is opt-in per schema. Without a single `acl` declaration, every
schema is owner-only — `userId` from the JWT scopes every read and
write. Once you opt in, two scopes apply:

| Scope | Where declared | What it does |
|-------|----------------|--------------|
| Document-level | `schema.acl.{ list, delete }` | Listed roles bypass the `userId` filter for the named operation. |
| Field-level | `field.acl.{ read, create, update }` | Listed roles see / write the field; everyone else sees responses with the field stripped, and writes that supply the field server-side rejected. |

Roles travel in the JWT's `roles` claim. The default User model
issues `['user']` on registration; admin / staff / hr roles are
your responsibility to assign (typically a custom route or a script
operated by a trusted admin).

## Document-level ACL

```js
module.exports = {
  path: 'order',
  fields: [/* ... */],
  acl: {
    list: ['admin', 'support'],     // see across tenants on list / find / search
    delete: ['admin'],              // delete records they don't own
  },
};
```

| Slot | Bypass on |
|------|-----------|
| `list` | List endpoints (`GET /api/v1/<path>`), `findMany` / `findOne` / `count` resolvers, `list_<path>` MCP tool, full-text search, audit-log history, aggregations. |
| `delete` | DELETE by id, `<path>RemoveById` GraphQL, `delete_<path>` MCP. Restore inherits from `delete`. |

Without a slot, that operation stays owner-only. Only callers whose
JWT carries one of the listed roles bypass the `userId` filter; any
other role is treated as owner-only.

There's deliberately no `create` or `update` slot at the document
level — write operations always stamp `userId`/`accountId` from the
caller's JWT, so cross-tenant writes are structurally impossible.
Field-level ACL is the right tool when only some roles can set
certain fields.

## Field-level ACL

```js
{ name: 'salary', type: Number, acl: { read: ['admin', 'hr'] } }
{ name: 'tags',   type: [String], acl: { update: ['admin'] } }
{ name: 'notes',  type: String, acl: { create: ['admin'], update: ['admin'] } }
```

| Slot | Effect |
|------|--------|
| `read` | The field is stripped from REST responses, GraphQL output, MCP tool results, search snippets, history rows, and webhook payloads for callers without an overlapping role. |
| `create` | If a caller without an overlapping role supplies the field on POST, the framework strips it server-side. |
| `update` | Same, but on PUT / GraphQL `<path>UpdateById` / MCP `update_<path>`. |

`create` and `update` strip rather than reject so an agent isn't
trapped by a payload it didn't know was sensitive — same posture
as tenant-stamped fields. If you need hard rejection, write a
custom route.

## Symmetric coverage

The same `projectByAcl` helper runs everywhere:

| Surface | Where ACL projection runs |
|---------|---------------------------|
| REST list / get / by-id | After the find. |
| REST POST / PUT | Before the write (input filter). |
| GraphQL output | `<path>Type.applyAclProjection` resolver wrapper. |
| GraphQL input | `filterWritable` strips non-writable fields. |
| MCP `list_*` / `get_*` | Same projector as REST. |
| MCP `create_*` / `update_*` | Same input filter. |
| Search results | Before the response. |
| Relations (`__include`) | Each populated record runs through the target schema's projector. |
| Audit log `history` | Before / after / diff projections all ACL-filtered. |
| Outbound webhook payloads | Same projector as audit. |

There's no side channel that bypasses ACL.

## Roles in the JWT

```json
{
  "user_id": "65a0...",
  "email":   "admin@example.com",
  "roles":   ["admin"]
}
```

The framework reads `req.user.roles` (REST) and `ctx.user.roles`
(GraphQL / MCP). Missing or empty `roles` defaults to `['user']`.
Issuing roles is up to your application — `routes/auth/` is
hand-written, so attach `roles` in your custom registration /
admin-promotion logic.

## Combining document and field ACL

A common pattern: admin operators see all rows, but salary stays
visible only to admin and HR.

```js
acl: { list: ['admin', 'support'] },
fields: [
  /* ... */
  { name: 'salary', type: Number, acl: { read: ['admin', 'hr'] } },
],
```

A `support` user can list rows from any tenant, but `salary` is
stripped. An `admin` user sees every row and every field. An
`hr` user is owner-only on the document level but sees `salary`
on rows they own.

## What ACL is *not*

- **Not row-level access control beyond owner / role.** dAvePi has owner-only or role-bypass; there's no "user A can read this specific document of user B" granularity. If you need that, layer a sharing collection on top.
- **Not OAuth scopes.** Roles are coarse — admin / hr / support / user. For fine-grained API scopes, generate scoped tokens at the auth layer and check them in custom routes.
- **Not policy-as-code.** No CEL / Rego / OPA. The expressiveness is what fits in the schema vocabulary.

## See also

- [Tenant isolation](/concepts/tenancy/) — owner-only is the baseline ACL is opting *out* of.
- [Audit log](/features/audit/) — projection on history rows.
- [Webhooks](/features/webhooks/) — same projector for outbound payloads.
