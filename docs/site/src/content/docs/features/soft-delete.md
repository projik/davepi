---
title: Soft delete
description: Default-on tombstones — DELETE writes deletedAt, every read filters tombstones, restore is one call.
---

Every schema gets soft-delete by default. DELETEs don't remove the
row — they set a `deletedAt: Date` tombstone. Every list / get /
relation query filters tombstones out. The deleted record can be
restored by clearing the tombstone via a dedicated route, MCP tool,
or GraphQL mutation.

## Default on, opt out

```js
module.exports = {
  path: 'account',
  softDelete: false,   // hard-delete on DELETE; no `deletedAt` field
  fields: [/* ... */],
};
```

Without the explicit `false`, soft-delete is on. The loader adds
the `deletedAt: Date` field, the tombstone-filtering predicate, and
the restore endpoints.

## What gets generated

| Surface | Endpoint |
|---------|----------|
| REST | `DELETE /api/v1/<path>/:id` — sets `deletedAt`. |
| REST | `POST /api/v1/<path>/:id/restore` — clears `deletedAt`. |
| GraphQL | `<path>RemoveById` — soft-deletes. |
| GraphQL | `<path>Restore` — clears the tombstone. |
| MCP | `delete_<path>` — soft-deletes. |
| MCP | `restore_<path>` — clears. |
| Typed client | `api.<resource>.delete(id)` and `api.<resource>.restore(id)`. |

## Tombstone filter

Every framework-level query (REST list, GET by id, GraphQL find,
MCP list / get, relation traversal) injects `deletedAt: null`.
Mongo's `null` predicate matches both null and missing fields, so
the same query is correct against schemas where `softDelete: false`
(no `deletedAt` field on documents) and schemas where it's enabled.

## `__includeDeleted`

To see tombstoned rows on a list:

```http
GET /api/v1/account?__includeDeleted=true
```

The same flag on `get_<path>` and the GraphQL `findMany` resolver
opts those reads into tombstones. Defaults to false — so the
common case (`GET /:resource`) never returns deleted rows.

Relations **never** honour `__includeDeleted`. A parent's tombstoned
children stay invisible, regardless of the parent request. This
prevents a soft-deleted record from leaking through a relation.

## Restore

```http
POST /api/v1/account/abc/restore
Authorization: Bearer <token>
```

Returns the now-restored record. Restore is symmetric with delete —
same audit row (`action: 'restore'`), same webhook event
(`account.restored`), same ACL bypass via `acl.delete` (the role
that can soft-delete can restore).

## Hard delete (`softDelete: false`)

When opted out:

- `deletedAt` field is not added.
- DELETE removes the row.
- The `restore` route, mutation, and MCP tool are absent.
- `__includeDeleted` is a no-op.

Use this for resources where there's no business reason to recover
deleted state (e.g. session tokens, idempotency rows that have
their own TTL).

## Retention: auto-purge tombstones

If you want soft-deleted rows to eventually go away — say, GDPR
deletion windows — set `retention.tombstoneTtlDays`:

```js
module.exports = {
  path: 'contact',
  retention: { tombstoneTtlDays: 30 },
  fields: [/* ... */],
};
```

A daily sweep hard-deletes any tombstoned row older than
`tombstoneTtlDays`. See [Backup & retention](/operations/backup/).

## Cross-tenant `delete` bypass

Some operators legitimately need to soft-delete records they don't
own (admin staff cleaning up). Opt in via `acl.delete`:

```js
acl: { delete: ['admin'] },
```

Without the slot, DELETE is owner-only. With it, the listed roles
bypass the `userId` filter on DELETE — same posture as `acl.list`.
See [ACL](/features/acl/).

## See also

- [Schema file shape](/reference/schema/#softdelete) — top-level syntax.
- [Audit log](/features/audit/) — `delete` and `restore` actions.
- [Backup & retention](/operations/backup/) — `tombstoneTtlDays`.
