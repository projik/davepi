# davepi-plugin-audit

Immutable, append-only audit log for [dAvePi][davepi]. Subscribes to the in-process record event bus and writes one document per CRUD mutation into an auto-registered `audit` collection — with `before` / `after` snapshots, an RFC 6902 [JSON-Patch][rfc6902] `diff`, the actor's `userId`, request `ip` / `userAgent` / `reqId`, and the resource + action. Queryable through the standard REST + GraphQL surface, admin-only cross-tenant list, no API-level writes or deletes.

[davepi]: https://docs.davepi.dev
[rfc6902]: https://www.rfc-editor.org/rfc/rfc6902

## Install

```bash
npm install davepi-plugin-audit
```

Add it to your project's `package.json` under `davepi.plugins`:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-audit"]
  }
}
```

That's it — on boot, the plugin auto-registers the `audit` schema, attaches a `bus.on('record', ...)` listener, and creates the TTL index on `at`. Your existing schemas need **no changes**: every mutation through REST or GraphQL becomes one audit row.

## Configure

All config is env-driven:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUDIT_ENABLED`         | no | `true` | Master switch. Setting `false` leaves the plugin dormant — no schema registered, no events captured. |
| `AUDIT_RETENTION_DAYS`  | no | `365` | TTL index on the `at` field. `0` disables retention (audit rows are kept forever) and drops any existing TTL index. |
| `AUDIT_BULK_BYPASS`     | no | `false` | When `true`, bulk events (`PUT /api/{v}/{path}`, GraphQL `updateMany` / `removeMany`) are NOT audited. See *Storage and bulk events* below. |
| `AUDIT_INCLUDE`         | no | *(all)* | Comma-separated allowlist of resource names. Empty / unset means "all resources". |
| `AUDIT_EXCLUDE`         | no | — | Comma-separated denylist. Wins over `AUDIT_INCLUDE` on conflict. |
| `AUDIT_REDACT`          | no | `password,token,secret` | Comma-separated field names whose values are replaced with `[REDACTED]` in `before` and `after`, recursively. Independent of the `pino` redaction set in the framework's logger. |

Setting `AUDIT_INCLUDE=order,invoice` audits only those two resources. Setting `AUDIT_EXCLUDE=otp` skips the `otp` resource even if it's in the allowlist (denylist wins). Setting `AUDIT_REDACT=ssn,taxId` *replaces* the default redaction list — if you also want `password` redacted, add it back: `AUDIT_REDACT=password,token,secret,ssn,taxId`.

## What gets written

Each row carries these fields (schema declared at boot):

| Field | Description |
|-------|-------------|
| `userId`      | The actor's user_id from the mutation's JWT. The tenant the row "belongs to" for read scoping. |
| `accountId`   | The actor's accountId, when the mutated record had one. |
| `action`      | One of `created`, `updated`, `deleted`, `transitioned`, or any custom string supplied to `plugin.record({...})`. |
| `resource`    | The schema `path` (e.g. `order`, `invoice`). |
| `resourceId`  | The single-record `_id`, or `null` for bulk events. |
| `before`      | The pre-mutation snapshot (post-redaction). `null` for `created`, populated for `updated` / `deleted`, also populated for `transitioned`. May be `null` on GraphQL paths where the framework doesn't fetch a `before`. |
| `after`       | The post-mutation snapshot (post-redaction). Populated for `created` / `updated` / `transitioned`, `null` for `deleted` on the hard-delete path. |
| `diff`        | An RFC 6902 JSON-Patch from `before` to `after`. Stable shape regardless of which side is `null`. |
| `filter`      | Mongo filter for bulk events (`updateMany`). |
| `numAffected` | Number of records changed by a bulk event. |
| `ip`, `userAgent`, `reqId` | Request metadata captured at the producing handler. May be `null` for non-HTTP producers (the MCP tools, internal jobs). |
| `at`          | Timestamp the row was written (also drives the TTL index). |

The standard `createdAt` / `updatedAt` are also there from the framework's mongoose-timestamp plugin, but `at` is the canonical time-of-event field — it's what the TTL is keyed on, and it's what you sort by when reconstructing a history.

## Reading the audit log

The plugin's `audit` schema is registered like any other dAvePi schema, so every standard surface works:

### REST

```bash
# All events for one record
GET /api/v1/audit?resource=order&resourceId=<oid>&__sort=at:desc

# All deletes for the last 30 days
GET /api/v1/audit?action=deleted&at__gte=2026-04-25T00:00:00Z

# Per-resource view
GET /api/v1/audit?resource=invoice&__sort=at:desc
```

### GraphQL

```graphql
query {
  auditMany(
    filter: { resource: "order" }
    sort: AT_DESC
    limit: 50
  ) {
    _id
    action
    resourceId
    userId
    before
    after
    diff
    at
  }
}
```

### Tenant scope

A regular caller sees only audit rows whose `userId` equals their own — the standard dAvePi owner-scope rule, applied to the audit collection like every other resource. The `audit` schema declares `acl.list = ['admin']`, so callers carrying the `admin` role bypass the owner predicate and see cross-tenant rows. Promote a compliance reviewer's user with `db.users.updateOne({_id}, {$set: {roles: ['admin', 'user']}})` (or your own admin management UI) to grant them the bypass.

## Append-only enforcement (and its limits)

The plugin enforces append-only at the **API layer**:

- Every field declares an ACL whose only allowed role is a sentinel value no real user holds, so `filterWritable` (the framework's pre-persist strip pass) drops every key from `POST` / `PUT` / bulk-PUT request bodies — the resulting `$set` is empty, the write is a no-op.
- The schema declares `beforeCreate` / `beforeUpdate` / `beforeDelete` hooks that throw `ForbiddenError`, so the REST single-record `POST` / `PUT /:id` / `DELETE /:id` paths (and their GraphQL `createOne` / `updateById` / `removeById` counterparts) return HTTP **403** with code `FORBIDDEN`.
- `acl.delete` is intentionally absent — admins don't get a tenant-bypass on delete either, and even an admin's owner-scoped delete is rejected by the hook above.

What this **doesn't** stop:

- A direct `db.audit.updateOne(...)` / `db.audit.deleteMany(...)` from someone who has Mongo shell access. Database-level immutability is the consumer's call: replica-set + RBAC, periodic archival to S3 with object-lock, or both. The plugin is the wire-side guarantee; the DBA owns the file-system side.
- GraphQL `auditRemoveMany` will go through `wrapFilter` for tenant scoping but does not currently invoke the `beforeDelete` hook (which is REST-only). A regular user can still delete their **own** audit rows via that mutation. If this matters in your deployment, either rebuild your admin UI to fence the mutation off, or run with `AUDIT_RETENTION_DAYS=0` and a separate replicated copy.

## Storage and bulk events

Audit rows carry full `before` + `after` snapshots, which means **the audit collection grows in proportion to your mutation rate × your record size**. A schema whose typical record is 4 KB and that sees 100 mutations/sec produces roughly 8 KB × 100 = 800 KB/s of audit data, or about 70 GB/day before redaction overhead. The defaults are tuned for typical CRUD apps (a few mutations per second per tenant); high-throughput workloads should:

1. Set `AUDIT_RETENTION_DAYS` to the regulatory minimum you can defend (e.g. 90 instead of 365).
2. Set `AUDIT_BULK_BYPASS=true` so a `updateMany({status: 'pending'}, ...)` doesn't explode into N audit rows — bulk events without bypass already write **one** row carrying `filter` + `numAffected`, but on a hot bulk path even that one row per call adds up.
3. Use `AUDIT_INCLUDE` to narrow the surface to compliance-relevant resources only. Most apps don't need `cache.*` or `session.*` events audited.

## Calling `record()` from a hook

The plugin also exports `record(entry)` for ad-hoc audit writes — handy when a non-CRUD event happens that you still want trailed:

```js
// schema/versions/v1/contract.js
const audit = require('davepi-plugin-audit');

module.exports = {
  path: 'contract',
  collection: 'contract',
  fields: [/* ... */],
  hooks: {
    afterUpdate: async ({ record, previous, user, req }) => {
      // A signature event isn't a normal CRUD verb — record it
      // under a custom action so it shows up alongside the
      // automatic updated/deleted/created rows.
      if (previous && !previous.signedAt && record.signedAt) {
        await audit.record({
          userId: user.user_id,
          action: 'contract_signed',
          resource: 'contract',
          resourceId: record._id,
          before: previous,
          after: record,
          ip: req && req.ip,
          userAgent: req && req.get && req.get('user-agent'),
          reqId: req && req.id,
        });
      }
    },
  },
};
```

`record()` is best-effort like the bus subscriber — a thrown Mongo error logs and is swallowed. The function returns `true` when the row was written and `false` otherwise (dormant plugin, failed write).

## Differences from the framework's in-tree audit

dAvePi already writes to a separate `audit_log` collection via `utils/audit.js`. That trail captures the same per-mutation before/after as this plugin's `audit` collection but isn't exposed through the schema-driven surface — there are no REST routes, no GraphQL types, no admin UI integration. For v1, both coexist:

- `audit_log` (in-tree): existing behaviour, no API surface, written by the persist sites in `utils/schemaLoader.js`.
- `audit` (this plugin): new collection, full REST + GraphQL + admin SPA + MCP surface, written by the bus listener.

Future versions may deprecate the in-tree path once the plugin is the canonical answer; for now, leave both running and query whichever one your tooling expects.

## Failure handling

- **Bus subscriber**: every audit write is wrapped in `try/catch`. A Mongo outage logs an `error` row via the framework's pino instance and is otherwise silent — the request loop is never blocked, and the user-facing response is committed even if the audit row is lost. Same posture as every other plugin bus subscriber.
- **TTL index management**: at boot the plugin tries to align the TTL on `at` with `AUDIT_RETENTION_DAYS`. A failure (Mongo not yet connected, missing permissions) logs a warning and continues — the index can be created manually later, or on the next process restart.
- **Boot**: a missing dependency (`mongoose`, `davepi/utils/errors`) logs an error and leaves the plugin dormant rather than failing boot. The framework continues to serve traffic without an audit trail; this is intentional for CI / staging without the package fully wired.

## License

ISC
