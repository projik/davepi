---
title: Self-host backup
description: mongodump cron, off-site rotation, file-blob backups, and the restore procedure for a self-hosted MongoDB deployment (the Docker Compose stack or a Mongo VM).
---

Self-hosting Mongo (either via the [production Docker Compose
stack](/operations/deployment/self-host/) or a Mongo VM you
manage) means you own the backup story. The standard pattern is
**daily `mongodump` to local disk, sync off-site, rotate**.

## What you need

- The host where Mongo runs has enough disk for ~3-7 days of
  dumps locally (a 50GB DB needs ~150GB headroom; `mongodump
  --gzip` typically compresses 5-10×).
- An off-site target (S3, B2, a NAS at a different location, a
  separate VPS) you can `rclone` / `aws s3 sync` to.
- A scheduling mechanism (host cron, systemd timer, or a
  sidecar container).

## Daily `mongodump` cron (Docker Compose stack)

If you're running the production stack from
`deploy/docker-compose.prod.yml`, the `mongo` service publishes
no host port — backups go through `docker compose exec`. Drop
this in `/etc/cron.daily/davepi-backup` on the host:

```bash
#!/bin/sh
# Daily mongodump → local archive → off-site rsync.
# Run as root via /etc/cron.daily (or systemd timer).
set -e

cd /srv/davepi
ts=$(date -u +%Y%m%dT%H%M%SZ)
out=/srv/backups/davepi-$ts.archive.gz

# mongodump --archive --gzip writes a single compressed file to
# stdout, which we redirect to a host path. -T prevents Docker
# from allocating a TTY (would corrupt the binary stream).
docker compose -f deploy/docker-compose.prod.yml \
  exec -T mongo mongodump --archive --gzip > "$out"

# Off-site sync (S3 example). Use rclone for B2 / Wasabi / etc.
aws s3 cp "$out" s3://acme-backups/davepi/ \
  --storage-class STANDARD_IA

# Rotate local: keep 14 days. Off-site lifecycle handles the
# longer tail (see below).
find /srv/backups -name 'davepi-*.archive.gz' -mtime +14 -delete
```

```bash
chmod +x /etc/cron.daily/davepi-backup
# Verify cron picked it up:
run-parts --test /etc/cron.daily
```

Off-site lifecycle on S3 (sample bucket policy moves objects to
Glacier after 30 days and deletes after a year):

```json
{
  "Rules": [
    {
      "ID": "davepi-tiered",
      "Status": "Enabled",
      "Filter": { "Prefix": "davepi/" },
      "Transitions": [{ "Days": 30, "StorageClass": "GLACIER" }],
      "Expiration": { "Days": 365 }
    }
  ]
}
```

## Daily `mongodump` cron (bare Mongo VM)

If Mongo runs directly on a host (not in Docker), `mongodump` is
just a CLI:

```bash
#!/bin/sh
set -e
ts=$(date -u +%Y%m%dT%H%M%SZ)
mongodump \
  --uri mongodb://localhost:27017/davepi \
  --archive=/srv/backups/davepi-$ts.archive.gz \
  --gzip
aws s3 cp /srv/backups/davepi-$ts.archive.gz s3://acme-backups/davepi/
find /srv/backups -name 'davepi-*.archive.gz' -mtime +14 -delete
```

For RPO < 24h, lower the cron interval (hourly works; sub-hourly
needs an oplog-aware approach — see the Atlas guide for that
model, or run a replica set and use `mongodump --oplog`).

## File-blob backups

`mongodump` only covers the database. Blobs uploaded via
`type: 'File'` fields live elsewhere depending on the storage
backend. See [File-storage backup](/operations/backup/file-storage/)
for per-backend strategies. **Run blob backup on the same cadence
as the DB dump** so a restore doesn't see "Mongo says the file is
at key X but X isn't in the bucket".

## Restore

```bash
# Pull the latest archive from off-site.
aws s3 cp s3://acme-backups/davepi/davepi-20260511T060000Z.archive.gz /tmp/

# Restore into the running Compose stack:
docker compose -f deploy/docker-compose.prod.yml exec -T mongo \
  mongorestore --archive --gzip --drop < /tmp/davepi-20260511T060000Z.archive.gz

# --drop replaces the existing collections. Omit if you want a
# merge restore (rare; only for cherry-picking specific
# collections).
```

For a real DR test against a staging environment, follow the
[Restore drill](/operations/backup/restore-drill/) checklist.

## Filesystem snapshots (alternative)

If your host runs LVM, ZFS, or a cloud volume with snapshot
support (AWS EBS, GCP persistent disk), a filesystem snapshot of
the Mongo data directory is faster than `mongodump` for large
DBs — but it requires fsync-locking Mongo first to get a
consistent snapshot:

```bash
docker compose -f deploy/docker-compose.prod.yml exec mongo \
  mongosh --quiet --eval 'db.fsyncLock()'
# Take the snapshot here.
aws ec2 create-snapshot --volume-id vol-... --description "davepi-$ts"
docker compose -f deploy/docker-compose.prod.yml exec mongo \
  mongosh --quiet --eval 'db.fsyncUnlock()'
```

Trade-off: snapshots are faster but tied to the filesystem; you
can't restore a snapshot from ext4 onto a ZFS host. `mongodump`
archives are portable. For most self-hosted setups, `mongodump`
is the right shape; snapshots help past ~100GB databases.

## What dAvePi already does for you

The [Backup & retention overview](/operations/backup/) covers the
framework-level auto-cleanup: idempotency keys (TTL-swept),
audit log (configurable retention), soft-delete tombstones
(configurable purge), webhook delivery rows (TTL'd). None of
those need separate backup handling — they're either bounded by
TTL or covered by the full `mongodump`.

## See also

- [File-storage backup](/operations/backup/file-storage/)
- [Restore drill](/operations/backup/restore-drill/)
- [Self-host deployment](/operations/deployment/self-host/)
