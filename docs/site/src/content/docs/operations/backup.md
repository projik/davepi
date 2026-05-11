---
title: Backup & retention
description: How to back up dAvePi data, what the framework purges automatically, and how to test the restore path. Per-platform deep dives for self-host, Atlas, DocumentDB, and Cosmos.
---

dAvePi stores everything it cares about in two places:

1. **MongoDB** — every record, every audit row, every idempotency
   token, every webhook delivery row, every migration record.
2. **File storage** — blobs for `type: 'File'` fields. Local
   disk, S3, or GCS depending on your config.

Backups need to cover both. Restores need to put both back in
sync. This page covers the framework-level invariants (what to
back up, what the framework already purges, retention
configuration); per-platform deep dives live one click deeper.

## Per-platform guides

| Where Mongo lives | Guide |
|-------------------|-------|
| Self-hosted Mongo on a VM (e.g. the Docker Compose stack) | [Self-host backup](/operations/backup/self-host/) |
| MongoDB Atlas | [Atlas backup](/operations/backup/atlas/) |
| AWS DocumentDB | [DocumentDB backup](/operations/backup/documentdb/) |
| Azure Cosmos DB (Mongo API) | [Cosmos backup](/operations/backup/cosmos/) |

For uploaded blobs:

- [File-storage backup](/operations/backup/file-storage/) — strategies for `local`, `s3`, and `gcs` storage drivers.

And the most important page nobody reads until 3am:

- [Restore drill](/operations/backup/restore-drill/) — a documented rehearsal procedure. Untested backups aren't backups.

## What to back up (and what not to)

The whole database, with a couple of exceptions:

| Collection | Back up? | Why |
|------------|----------|-----|
| Every schema-driven collection | **Yes** | This is your data. |
| `audit_log` | **Yes** | Compliance + post-incident forensics. Subject to `retention.auditTtlDays` per-schema (see below). |
| `_davepi_migrations` | **Yes** | Losing this means the migration runner thinks it needs to re-run everything. Catastrophic if migrations aren't idempotent. |
| `idempotency_key` | No (optional) | Auto-purged after `IDEMPOTENCY_TTL_SECONDS` (default 24h). It's a retry-correctness mechanism, not history. |
| `webhook_delivery` | No (optional) | Auto-purged after `WEBHOOK_DELIVERY_TTL_DAYS` (default 30). Operational telemetry, not data. |

If you really need a partial restore, grab the full dump and
filter on restore.

## Framework-managed retention

Three things the framework purges automatically. Configuration
lives on the schema or in env vars.

### Idempotency tokens

`idempotency_key` rows have an `expiresAt` TTL — defaults to 24h,
override with `IDEMPOTENCY_TTL_SECONDS`. Mongo's TTL monitor
sweeps expired rows on its background cycle (~60s). Collection
size stays bounded.

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

### Webhook delivery rows

`webhook_delivery` is auto-purged after `WEBHOOK_DELIVERY_TTL_DAYS`
(default 30). No per-schema knob.

## Before a destructive operation

| Operation | Snapshot before |
|-----------|-----------------|
| Running a migration | Take a Mongo backup. Migrations should be idempotent and have a `down`, but a snapshot is your safety net. |
| Bulk delete via the admin SPA | Same. |
| `db.collection.dropIndex` | Take a snapshot, then run the migration that re-creates whatever the framework needs. |
| `npx davepi migrate down` | Snapshot first — `down` is best-effort, and some operations don't have a clean inverse. |
| Tuning `retention.tombstoneTtlDays` shorter | Snapshot first. The next sweep will hard-delete rows that fell out of the new window. |

## Recovery point + recovery time targets

A useful mental model when picking a platform-specific backup
strategy:

| Target | What it means |
|--------|---------------|
| **RPO** (recovery point objective) | How much data you can afford to lose. If your last good backup is 24h ago, your RPO is 24h. |
| **RTO** (recovery time objective) | How long it takes to bring the system back. A `mongorestore` from S3 of a 500GB database isn't a 10-minute operation. |

| Platform | Typical RPO | Typical RTO (small DB) | Cost shape |
|----------|------------|------------------------|------------|
| Self-host with daily `mongodump` cron | 24h | 30-60 min | Storage of dumps + your time |
| Self-host with hourly `mongodump` cron | 1h | 30-60 min | Same |
| Atlas continuous backup | <1 min (oplog) | 5-20 min | Included in M10+ tiers |
| DocumentDB automated snapshots | 5 min (oplog) | 10-30 min | Included; longer retention costs extra |
| Cosmos continuous backup | <1 min | 5-30 min | Built-in once enabled |

The pages above walk through configuring each.

## See also

- [Soft delete](/features/soft-delete/) — `tombstoneTtlDays`.
- [Audit log](/features/audit/) — `auditTtlDays`.
- [Webhooks](/features/webhooks/) — `webhook_delivery` rows.
- [Migrations](/operations/migrations/) — the `_davepi_migrations` collection.
- [Deployment](/operations/deployment/) — each per-platform deploy guide links here.
