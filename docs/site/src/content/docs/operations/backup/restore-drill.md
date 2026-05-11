---
title: Restore drill
description: A documented quarterly rehearsal procedure. Untested backups aren't backups. This page is the checklist — print it, do it, sign off.
---

A backup you've never restored isn't a backup. The first time
you find out the dump is corrupt, the cron stopped running three
weeks ago, or the IAM role can't actually read the bucket should
not be at 3am during an incident.

This page is the checklist. **Run it quarterly.** Sign off in
the team's runbook with the date and the issues you found.

## The drill, top to bottom

### 0. Pick a target

| You're testing | Use |
|----------------|-----|
| The full restore path (DB + blobs) | A fresh staging environment with its own Mongo + its own bucket. |
| Just the DB backup | A scratch cluster (Atlas's "restore to new cluster" / DocumentDB's `restore-db-cluster-to-point-in-time` / a docker run mongo). |

**Never restore to production** during a drill. The point is to
prove the backup works, not to find out the hard way that the
`--drop` flag was the wrong choice.

### 1. Locate the backup

- [ ] Confirm the latest scheduled backup completed within the
      expected window (last 24h for a daily cron; last hour for
      hourly).
- [ ] Open the off-site copy. If you can't list the bucket, the
      drill stops here — fix the access path before continuing.
- [ ] Note the timestamp and size. A backup that's suddenly
      half the usual size is a red flag.

### 2. Restore the database

- [ ] Download or restore the archive into the scratch cluster.
- [ ] Run a Mongo-side sanity check:

```bash
docker run --rm -it mongo:7 \
  mongosh "<restored-uri>" --eval '
    db = db.getSiblingDB("davepi");
    print("collections:", db.getCollectionNames().length);
    print("audit_log:", db.audit_log.countDocuments({}));
    print("_migrations:", db._migrations.countDocuments({}));
  '
```

- [ ] Confirm the collection count is sensible (matches
      production's `_describe` schema count + framework
      collections).
- [ ] `_migrations` is present — without this, the
      migration runner thinks the DB is fresh and may re-run
      everything.

### 3. Boot dAvePi against the restored DB

- [ ] Set `MONGO_URI` to the restored cluster.
- [ ] Boot the framework. Watch the log for:
  - `listening on port <N>` — the basic boot worked.
  - Any `error`-level log lines during the schema loop —
    a schema file that depends on a migration that didn't apply
    will fail here.
- [ ] Hit `GET /_describe`. The response should list every
      schema you expect to see. If a schema is missing, the
      restore didn't include the right collections.
- [ ] Hit `GET /api/v1/<known-resource>` with a real JWT. A
      list of records should come back.

### 4. Verify migrations

- [ ] Run `npx davepi migrate status`. Every entry should read
      `succeeded`. Anything `pending` means the restore is
      missing migration records — likely a partial-restore bug.

### 5. Spot-check a state machine

If you have schemas with state machines:

- [ ] Read a record's `availableTransitions`. Should match the
      schema's declared `transitions[<current state>]`.
- [ ] Attempt an invalid transition — should return 400
      `INVALID_TRANSITION` with the correct `allowed` list. If
      it succeeds, the schema's state machine wasn't restored
      correctly.

### 6. Verify file blobs

- [ ] Pick a record with a `type: 'File'` field set.
- [ ] Call the fetch endpoint
      (`GET /api/v1/<path>/:id/<field>`). Should return the URL
      or stream the blob.
- [ ] If the response is "blob not found" but the `FileMeta`
      sub-document is present, the DB and storage backups were
      taken at different points. See [File-storage backup](/operations/backup/file-storage/#restore-consistency-the-filemeta--blob-check).

### 7. Verify auth + ACL

- [ ] Issue a new JWT via `POST /login`. If this fails, the
      `user` collection didn't restore or the `TOKEN_KEY` env
      var doesn't match what was used to sign the existing
      tokens.
- [ ] If your schemas use `acl.list` or field-level `acl.read`,
      hit an endpoint as both an admin and a regular user. Both
      should match the documented per-role projection.

### 8. Tear down

- [ ] Drop the scratch cluster / staging environment.
- [ ] **If you're using Atlas's "restore to new cluster" UI,
      double-check you're deleting the *restored* cluster, not
      production.** The names look similar mid-drill.

## What to write down

After the drill, capture:

1. **Date** of the drill.
2. **Backup timestamp** restored.
3. **Total time** from "decide to drill" to "scratch cluster
   serving GET /_describe".
4. **Issues found** — even small ones. ("Backup archive name
   format changed; alerts based on the old name didn't fire.")
5. **Action items** — fix the issues before the next drill.

The total time is your real RTO. If it's higher than your stated
recovery target, you have work to do before you actually need
the backup.

## When the drill fails

Common failure modes and what they mean:

| Failure | Likely cause |
|---------|--------------|
| Can't list the off-site bucket | IAM role / credentials drifted from what's set on the host. |
| Archive download is incomplete / corrupted | Backup didn't complete; cron failure, OOM kill, disk-full. |
| `mongorestore` fails partway through | Source archive is corrupt, or the target cluster's storage filled up. |
| Restored DB has no collections | Restore command pointed at the wrong DB name (`--db davepi` vs default). |
| `_describe` shows fewer schemas than production | Schema files weren't deployed alongside the restored data. The schemas live in source code, not the DB; restore alone doesn't bring them back. |
| Auth returns 401 for known credentials | Restored DB but the host's `TOKEN_KEY` doesn't match what signed the existing tokens. (Use the same `TOKEN_KEY` across deploys, or accept that restores invalidate existing sessions.) |
| `FileMeta` rows exist but blobs are 404 | DB and storage backups drifted in time. |

## Frequency

- **Quarterly** at minimum. Calendar it.
- **After any change to the backup pipeline** (new bucket, new
  cron schedule, new region). The first drill after a change is
  the high-value one.
- **Before launching a new product surface** that depends on
  durable data. "We can restore from yesterday" only matters if
  it's true.

## See also

- [Per-platform backup guides](/operations/backup/)
- [File-storage backup](/operations/backup/file-storage/) —
  including the FileMeta ↔ blob consistency check.
