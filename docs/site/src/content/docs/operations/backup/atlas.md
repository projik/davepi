---
title: MongoDB Atlas backup
description: Continuous Cloud Backup with point-in-time recovery, cross-region snapshot copy, and how the M0/M10/M30+ tiers differ. The lowest-effort backup story for dAvePi.
---

Atlas is the lowest-effort backup story for dAvePi — once
configured, continuous backup runs in the background with
point-in-time recovery measured in oplog positions. The
trade-off is the tier minimum (M10+, ~$57/mo) to get continuous
backup at all.

## What each Atlas tier gives you

| Tier | Continuous backup | PITR window | Cross-region snapshot copy |
|------|-------------------|-------------|---------------------------|
| M0 (free) | No | — | — |
| M2 / M5 (shared) | No | — | — |
| M10+ | Yes (default 24h, configurable to 7d) | Yes, up to the PITR window | Yes, per snapshot policy |
| M40+ | Same + snapshot scheduling controls | Yes | Yes |

For development / hobby projects on M0, the only "backup"
available is a manual `mongodump`. For production, the practical
floor is M10.

## Enable continuous backup (M10+)

In the Atlas UI:

1. Cluster → **Backup** tab.
2. **Cloud Backup** → Enable (if not already on by default).
3. Configure the **snapshot schedule**: how often Atlas takes
   point-in-time snapshots. Defaults are sensible (every 6 hours
   + daily + weekly + monthly).
4. **Point-in-time restore window** — defaults to 24h on M10,
   bump to 72h or 7 days depending on what you need to recover
   from.

That's it. No cron, no shell scripts on your end.

## Point-in-time restore

To restore to a specific timestamp:

1. Cluster → Backup → **Restore**.
2. Pick **Continuous Cloud Backup** (not "snapshot").
3. Choose a target timestamp within the PITR window — Atlas
   replays oplog from the nearest snapshot up to your chosen
   moment.
4. Pick the destination: same cluster (in-place, **destructive**),
   different cluster, or a new cluster spun up just for restore.

For DR testing, **always restore to a new cluster** — never
in-place against production until you've verified the restore is
clean.

## Cross-region snapshot copy

For DR against a regional outage, configure snapshot copy in the
backup policy:

1. Backup policy → **Snapshot distribution**.
2. Add the secondary region.
3. Pick retention — usually shorter than the primary (DR backups
   are for "primary region gone", not for "restore from a year
   ago").

Atlas handles the snapshot replication. The DR restore process is
the same as a normal restore but originating from the copied
snapshot in the secondary region.

## Take a one-off snapshot before a destructive operation

Before running a migration or any operation listed in the
[overview's "Before a destructive operation" table](/operations/backup/):

1. Cluster → Backup → **Take Snapshot Now**.
2. Wait for the snapshot to complete (a few minutes).
3. Run the destructive operation.
4. If it goes wrong, restore from the snapshot you just took.

## Test it: schedule a restore drill quarterly

The [Restore drill checklist](/operations/backup/restore-drill/)
applies directly. Atlas's "restore to a new cluster" flow is the
easiest way to do a drill without touching production data —
spin up a fresh cluster, restore yesterday's snapshot, point a
staging dAvePi at it, run smoke queries.

## File-blob backups

Atlas only covers the database. Blobs in your storage backend
(S3 / GCS / local) need their own backup story — see
[File-storage backup](/operations/backup/file-storage/). For most
production setups: an S3 bucket with versioning enabled + a
cross-region replication rule.

## Common gotchas

- **The PITR window is a rolling window.** If you bump it from
  24h → 7d, the next 7 days will gradually fill the new window;
  you can't PITR to "5 days ago" until 5 days after the bump.
- **Snapshot count counts.** Free tier of snapshot storage on
  M10 is generous but not infinite. If you keep monthly snapshots
  for 10 years, you'll pay for the extra storage.
- **Restore time depends on size.** A 1TB cluster restore takes
  hours, not minutes. Your RTO needs to assume that. For
  smaller-cluster + frontend caching architectures, the practical
  RTO is dominated by DNS propagation + Atlas restore time.
- **PITR can't replay past schema changes.** If you ran a
  migration at 14:00 and the data corruption you're recovering
  from happened at 13:00, restoring to 13:30 means the schema
  expects the post-migration shape but the data is
  pre-migration. Either restore further back (before the
  migration) and re-apply, or restore in place and run a
  catch-up migration manually.

## See also

- [File-storage backup](/operations/backup/file-storage/)
- [Restore drill](/operations/backup/restore-drill/)
- [Atlas-paired deployments](/operations/deployment/) — Render, Fly, GCP guides default to Atlas.
