---
title: AWS DocumentDB backup
description: Automated snapshots, retention configuration, manual snapshots, cross-account / cross-region copy, and the limits of DocumentDB's restore model compared to MongoDB Atlas.
---

DocumentDB's backup model is **automated daily snapshots plus
continuous backup via the oplog** — similar in shape to Atlas
but with AWS conventions and the usual DocDB compatibility
caveats.

## What you get by default

When you create a DocumentDB cluster, automated backups are on:

- **Daily snapshots**, retained for **1 day** by default (max 35
  days; configurable on cluster creation or in Maintenance
  settings).
- **Continuous backup** (via the oplog) within the retention
  window, enabling **point-in-time restore** to any second.

Snapshots are stored in S3, managed by AWS; you don't pay extra
for the storage of snapshots up to the size of the cluster.

## Configure retention

1. RDS Console → **Document Databases** → your cluster →
   **Modify**.
2. **Backup retention period** → bump from 1 day to whatever
   matches your RPO. 7-14 days is a typical production setting.
3. **Backup window** → pick a low-traffic UTC window.
4. Apply immediately or during the next maintenance window.

```bash
# Via CLI:
aws docdb modify-db-cluster \
  --db-cluster-identifier davepi-cluster \
  --backup-retention-period 14 \
  --preferred-backup-window 03:00-04:00 \
  --apply-immediately
```

## Manual snapshot before a destructive operation

```bash
aws docdb create-db-cluster-snapshot \
  --db-cluster-snapshot-identifier davepi-pre-migration-$(date -u +%Y%m%d) \
  --db-cluster-identifier davepi-cluster
```

Manual snapshots **persist past the retention window** — useful
before risky operations (migrations, schema changes, bulk
deletes). Delete them when you no longer need them; they count
against your account's snapshot quota.

## Point-in-time restore

```bash
aws docdb restore-db-cluster-to-point-in-time \
  --db-cluster-identifier davepi-restored \
  --source-db-cluster-identifier davepi-cluster \
  --restore-to-time 2026-05-11T13:00:00Z
```

Creates a **new cluster** at the requested timestamp. Cannot
restore in-place — the new cluster is independent. To cut over
production traffic, update the app's `MONGO_URI` env var to the
new cluster endpoint.

## Cross-region / cross-account copy

For DR, copy snapshots to a second region or account:

```bash
# Cross-region (within the same account):
aws docdb copy-db-cluster-snapshot \
  --source-db-cluster-snapshot-identifier arn:aws:rds:us-east-1:123456789012:cluster-snapshot:davepi-snap \
  --target-db-cluster-snapshot-identifier davepi-snap-dr \
  --kms-key-id <kms-key-id-in-target-region> \
  --source-region us-east-1
```

For cross-account, you need a shared KMS key and IAM permission
for the target account to read the snapshot. The AWS RDS docs
have a step-by-step.

Schedule this as a Lambda triggered by the EventBridge
"snapshot-completed" event so every new snapshot replicates
automatically.

## DocumentDB vs Atlas: backup-specific differences

| | DocumentDB | Atlas |
|-|------------|-------|
| Continuous backup | Yes (within retention window) | Yes (PITR window) |
| Max retention | 35 days | Up to 7 days PITR; longer via snapshot policy |
| Restore in-place | No (new cluster only) | Yes |
| Cross-region | Snapshot copy (manual / Lambda) | Built into backup policy |
| Granularity | Per-second within retention | Per-second within PITR window |
| Cost | Included in storage tier | Included in M10+ |

In practice the user-facing experience is similar; DocumentDB's
"new cluster" restore model is slightly heavier than Atlas's
in-place option, but both restore times are in the
tens-of-minutes range for small clusters.

## File-blob backups

DocumentDB only covers the database. For `type: 'File'` blobs in
S3, see [File-storage backup](/operations/backup/file-storage/) —
S3 versioning + lifecycle to a glacier-tier bucket is the
standard answer.

## Common gotchas

- **`mongodump` doesn't work on DocumentDB clusters that have
  TLS enforced and the wrong CA bundle**. Make sure you've
  installed the [Amazon RDS CA bundle](https://docs.aws.amazon.com/documentdb/latest/developerguide/security.connecting.html)
  on whatever host runs your ad-hoc dumps.
- **No `--oplog` support on DocumentDB**. The continuous-backup
  feature is server-side; the application-level `mongodump
  --oplog` won't work.
- **Snapshot quotas** — manual snapshots that persist past
  retention count against per-region limits.
- **Migration drift**. If you restore to a point in time before a
  schema migration ran, but the application code expects the
  post-migration shape, you'll get errors until you replay the
  migration. The `_davepi_migrations` collection is part of the
  restore, so the migration runner will see it as not-yet-run and
  re-apply on next boot.

## See also

- [File-storage backup](/operations/backup/file-storage/)
- [Restore drill](/operations/backup/restore-drill/)
- [AWS deployment guide](/operations/deployment/aws/)
