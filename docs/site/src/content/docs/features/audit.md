---
title: Audit log
description: Every create / update / delete / restore / state-machine transition writes a row to audit_log — readable via REST, GraphQL, and MCP.
---

Every schema with `audit: true` (the default) writes an audit row
on every mutation. Reads are surfaced as a per-record history
endpoint, a GraphQL field, an MCP `history_<path>` tool, and a
typed client method.

## What gets recorded

| Action | When |
|--------|------|
| `create` | POST / GraphQL `<path>CreateOne` / MCP `create_<path>`. |
| `update` | PUT / GraphQL `<path>UpdateById` / MCP `update_<path>`. |
| `delete` | DELETE — soft or hard. |
| `restore` | `POST /:id/restore`. |
| `transition` | Any state-machine transition. |

## Storage shape

```json
{
  "_id": "65c0...",
  "schemaPath": "quote",
  "documentId": "65b1...",
  "action": "transition",
  "userId": "65a0...",
  "before":  { "status": "review" },
  "after":   { "status": "approved" },
  "diff":    { "status": { "from": "review", "to": "approved" } },
  "field":   "status",
  "createdAt": "2026-05-10T12:00:00Z"
}
```

| Key | Description |
|-----|-------------|
| `schemaPath` / `documentId` | The record this row belongs to. |
| `action` | `create` / `update` / `delete` / `restore` / `transition`. |
| `userId` | The actor's tenant identity, from the JWT. |
| `before` / `after` | Document projections at each end of the change. ACL-projected, so a hidden field never leaks into history. |
| `diff` | Field-level `{ from, to }` map. Only fields that changed are present. |
| `field` | Set on `transition` rows — the state-machine field that moved. |
| `createdAt` | When the row was written. |

Audit writes are best-effort. The framework writes the row in a
fire-and-forget pattern after the mutation succeeds — a Mongo
write failure on the audit log is logged but does not fail the
caller's request. Use the rate of audit writes as a health metric
on your dashboard.

## Reading history

### REST

```http
GET /api/v1/quote/abc/history
```

Returns:

```json
{
  "results": [
    { "action": "transition", "field": "status", "diff": {/* ... */}, "createdAt": "..." },
    { "action": "update",     "diff": {/* ... */}, "createdAt": "..." },
    { "action": "create",     "after": {/* ... */}, "createdAt": "..." }
  ]
}
```

Newest first. Same pagination params as the list endpoint
(`__page`, `__sort`).

### GraphQL

```graphql
{
  quoteHistory(_id: "abc") {
    action, field, before, after, diff, createdAt
  }
}
```

### MCP

```json
{
  "name": "history_quote",
  "arguments": { "id": "abc" }
}
```

### Typed client

```ts
const history = await api.quote.history('abc');
// AuditEntry[] with discriminated `action` field
```

## ACL projection

`before`, `after`, and `diff` are run through the schema's ACL
projector at *read* time. A user without `read: ['admin']` on
`salary` doesn't see salary changes in history — even if they're
allowed to see the rest of the record.

The same projection is applied to webhook payloads: the audit log
and outbound webhooks share the same projection layer, so there's
no side channel that bypasses ACL.

## Cross-tenant history (`acl.list`)

History reads honour the schema's `acl.list` slot — operators with
the listed role can read any record's history, not just their own.

Without `acl.list`, history is owner-only.

## Opting out

```js
module.exports = {
  path: 'session_event',
  audit: false,        // no audit rows; history endpoints absent
  fields: [/* ... */],
};
```

Use for high-volume / low-value rows where the audit log itself
would dwarf the data. Common candidates: session events,
analytics rows, ephemeral caches.

## Retention

The audit log has its own collection (`audit_log`) and grows
linearly with mutations. **The framework does not auto-purge
audit rows** — they live forever unless you prune them manually.

For a bounded retention window (compliance, storage cost), run a
periodic prune on a cron:

```js
// Keep 1 year of audit rows. Run weekly.
db.audit_log.deleteMany({
  createdAt: { $lt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
});
```

Framework-side audit retention is a tracked enhancement; today
the auto-purge story stops at idempotency keys and soft-delete
tombstones. See [Backup & retention](/operations/backup/).

## See also

- [State machines](/features/state-machines/) — `transition` rows.
- [ACL](/features/acl/) — projection on history rows.
- [Webhooks](/features/webhooks/) — same projection layer.
- [Backup & retention](/operations/backup/) — manual pruning patterns.
