---
title: File-storage backup
description: Backup strategies for each file-storage driver — local and S3 — so the FileMeta sub-document and the actual blob stay in sync after a restore.
---

`type: 'File'` fields store metadata (key, size, content type,
checksum) as a sub-document in Mongo, and the actual blob in the
configured storage backend. A backup story that covers only Mongo
leaves you with `FileMeta` rows pointing at keys that aren't in
the bucket — broken downloads, missing attachments.

This page covers backing up the blob side per storage driver.
Restore is the inverse + the [restore drill](/operations/backup/restore-drill/)'s
final consistency check that every `FileMeta` in the DB has a
matching blob in the store.

## Local storage (`STORAGE_DRIVER=local`)

Blobs are written to `UPLOADS_DIR` (default `./uploads`).
Three options, in order of robustness:

### Filesystem snapshot

If the host runs LVM, ZFS, or a cloud volume with snapshot
support (AWS EBS, GCP persistent disk, Azure managed disk),
snapshot the volume holding the uploads directory on the same
cadence as the DB backup. Atomic, fast, and consistent against
in-flight writes.

### `rsync` / `restic` to off-site

Cron a daily sync. Cheap, portable, no snapshot support needed.

```bash
# /etc/cron.daily/davepi-uploads-backup
#!/bin/sh
set -e
restic -r s3:s3.amazonaws.com/acme-backups/davepi-uploads/ \
  --password-file /etc/restic.pw \
  backup /srv/davepi/uploads
restic -r s3:s3.amazonaws.com/acme-backups/davepi-uploads/ \
  --password-file /etc/restic.pw \
  forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
```

`restic` deduplicates so successive backups are cheap. The
forget+prune step keeps the bucket size bounded.

### `tar` archive (simplest)

For small upload directories, daily `tar -czf` to an off-site
target is fine:

```bash
tar -czf /tmp/uploads-$(date -u +%Y%m%d).tar.gz -C /srv/davepi uploads
aws s3 cp /tmp/uploads-*.tar.gz s3://acme-backups/davepi-uploads/
```

Becomes painful past ~10GB of uploads — switch to `restic` then.

## S3 (`STORAGE_DRIVER=s3`)

S3 has the strongest built-in primitives. Three layers:

### 1. Versioning on the primary bucket

```bash
aws s3api put-bucket-versioning \
  --bucket acme-davepi-uploads \
  --versioning-configuration Status=Enabled
```

Versioning lets you recover deleted or overwritten objects up to
the lifecycle policy's expiry. Protects against the most common
"oops" — accidental deletes from the app or operator error.

### 2. Lifecycle: transition cold versions to Glacier

```json
{
  "Rules": [
    {
      "ID": "davepi-uploads-tiered",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "NoncurrentVersionTransitions": [
        { "NoncurrentDays": 30, "StorageClass": "GLACIER" }
      ],
      "NoncurrentVersionExpiration": { "NoncurrentDays": 365 }
    }
  ]
}
```

Old object versions become recovery points; lifecycle keeps
storage cost in check.

### 3. Cross-region replication for DR

```bash
aws s3api put-bucket-replication \
  --bucket acme-davepi-uploads \
  --replication-configuration file://repl.json
```

`repl.json` defines the destination bucket in a different region.
Replication is async but typically completes within minutes; the
destination bucket should also have versioning + lifecycle.

### Mongo-side consistency

`FileMeta` records reference S3 by `key`. After an S3 restore
(from a deleted version or a replicated bucket), the keys still
match — no Mongo migration needed.

## GCS

A GCS driver is on the roadmap but not yet implemented — the
framework today supports `local` and `s3`. For Google Cloud
deploys, point the S3 driver at GCS's S3-compatible
interoperability endpoint, or run a small adapter service in
front of GCS that translates S3 API calls.

## Tombstone-driven cleanup

The framework's [soft-delete retention](/operations/backup/#soft-delete-tombstones)
(`softDelete: { retentionDays }`) deletes the matching file
blobs when it sweeps soft-deleted rows. **This deletion is
permanent at the storage layer** — once the sweep runs, the
blob's gone from S3 unless versioning or replication caught a
copy first.

If you use `softDelete: { retentionDays }` for GDPR /
right-to-be-forgotten compliance, you usually want the blob
actually deleted. Pair this with S3 versioning's
`NoncurrentVersionExpiration` so old versions of deleted blobs
also expire within the compliance window.

## Restore consistency: the FileMeta ↔ blob check

After a restore (DB + storage), verify the two sides agree. The
restore drill includes this as a step:

```js
// Run inside a node REPL pointed at the restored DB:
const fileFields = [/* per-schema list from `_describe` */];
for (const { resource, field } of fileFields) {
  const rows = await db.collection(resource).find({
    [`${field}.key`]: { $exists: true },
  }).toArray();
  for (const row of rows) {
    const meta = row[field];
    const exists = await storage.exists(meta.key);  // backend-specific
    if (!exists) console.error(`orphan: ${resource}/${row._id} → ${meta.key}`);
  }
}
```

If you see orphans, the DB backup and the storage backup were
taken at different points and one captured a write the other
didn't. Fix the schedule so they run within a tight window of
each other.

## See also

- [Restore drill](/operations/backup/restore-drill/) — the
  end-to-end test that catches mismatches.
- [File uploads](/features/files/) — what the `type: 'File'`
  field actually does.
