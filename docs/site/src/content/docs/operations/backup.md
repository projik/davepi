---
title: Backup & retention
description: How to back up dAvePi data, what the framework purges automatically, and what you should snapshot before destructive operations.
---

dAvePi stores everything it cares about in two places:

1. **MongoDB** — every record, every audit row, every idempotency token, every webhook delivery row, every migration record.
2. **File storage** — blobs for `type: 'File'` fields. Local disk, S3, or GCS depending on your config.

Backups need to cover both. Restores need to put both back in
sync.

## Database backup

Use whatever tool fits your Mongo deployment:

| Setup | Tool |
|-------|------|
| MongoDB Atlas | Atlas Cloud Backups (continuous, point-in-time-restore). |
| Self-hosted replica set | `mongodump` (logical) or filesystem snapshots of the data volume (physical, faster, requires fsync-locking). |
| Single-node Mongo (dev / small prod) | `mongodump` on a cron, or volume snapshots of the host. |

The framework doesn't ship its own backup tool — the standard
ecosystem options are well-tested and your platform may already
have a managed solution.

### What to back up

The whole database. The framework writes to many collections and
doesn't separate "data" from "audit" — restoring a partial backup
risks orphan audit rows that reference missing documents.

If you really need a partial restore, grab the full dump and
filter on restore.

## File storage backup

| Backend | Backup approach |
|---------|----------------|
| `s3` | S3 versioning + lifecycle rules to a glacier-tier bucket. Cross-region replication for DR. |
| `gcs` | Object versioning + lifecycle to coldline. Cross-region replication. |
| `local` | Filesystem snapshots of the storage volume. |

Files and DB are written separately — back them up with the same
cadence so restores don't see "metadata in Mongo, blob missing in
S3" or vice versa.

## Framework-managed retention

Three things the framework purges automatically:

### Idempotency tokens

`idempotency_key` rows have an `expiresAt` TTL — defaults to 24h,
override with `IDEMPOTENCY_TTL_SECONDS`. Mongo's TTL monitor
sweeps expired rows on its background cycle (~60s). The collection
size bounded.

You don't need to back this collection up — it's purely a
correctness mechanism for in-flight retries, not history.

### Soft-delete tombstones (per-schema retention)

```js
module.exports = {
  path: 'contact',
  retention: { tombstoneTtlDays: 30 },
  fields: [/* ... */],
};
```

A daily sweep hard-deletes any row whose `deletedAt` is older than
`tombstoneTtlDays`. The matching file blobs (for `type: 'File'`
fields) are removed too. Useful for GDPR / right-to-be-forgotten
windows.

Without `tombstoneTtlDays`, tombstoned rows live forever — the
soft-delete is the retention.

### Audit log retention

```js
module.exports = {
  path: 'order',
  audit: true,
  retention: { auditTtlDays: 365 },
  fields: [/* ... */],
};
```

A daily sweep hard-deletes audit rows for this schema older than
`auditTtlDays`. Tune per schema based on the audit log's
compliance vs. storage trade-off.

The retention sweep itself writes one summary audit row per pass
so you can verify it ran.

## Webhook delivery rows

`webhook_delivery` grows linearly with mutations — every event,
every endpoint, every retry attempt is a row. Default retention is
30 days; override with `WEBHOOK_DELIVERY_TTL_DAYS`.

Like idempotency tokens, you don't typically need to back these up
— they're operational telemetry, not history.

## Migration records

`_davepi_migrations` tracks which migrations have run. **Always
back this up** — restoring a database snapshot but losing the
migration record means the migration runner thinks it needs to
re-run everything, which is fine if your migrations are
idempotent and a disaster if they aren't.

## Before a destructive operation

| Operation | Snapshot before |
|-----------|-----------------|
| Running a migration | Take a Mongo backup. Migrations should be idempotent and have a `down`, but a snapshot is your safety net. |
| Bulk delete via the admin SPA | Same. |
| `db.collection.dropIndex` | Take a snapshot, then run the migration that re-creates whatever the framework needs. |
| `npx davepi migrate down` | Snapshot first — `down` is best-effort, and some operations don't have a clean inverse. |

## Restore drill

A backup you've never restored is a backup you don't have. At
least once a quarter:

1. Grab the latest production backup.
2. Restore it into a staging environment.
3. Boot dAvePi against the staging Mongo.
4. Hit `GET /_describe` — confirms schemas load.
5. Hit `GET /api/v1/<resource>` — confirms a known sample query works.
6. Check the migration table — `npx davepi migrate status` should show all entries `succeeded`.

If any of those fail, the backup didn't capture what it needed to.
Better to find out now than at 3am.

## See also

- [Soft delete](/features/soft-delete/) — `tombstoneTtlDays`.
- [Audit log](/features/audit/) — `auditTtlDays`.
- [Webhooks](/features/webhooks/) — `webhook_delivery` rows.
- [Migrations](/operations/migrations/) — the `_davepi_migrations` collection.
