---
title: Azure Cosmos DB backup
description: Periodic vs Continuous backup modes, point-in-time restore up to 30 days, and the cost difference between the two backup policies.
---

Cosmos DB (Mongo API) ships with backup on by default, but the
default mode is **Periodic** which doesn't support point-in-time
restore. For a real production backup story, switch to
**Continuous** mode — it adds PITR up to 30 days at modest extra
cost.

## Periodic backup (default)

What you get without configuration:

- Snapshots every **4 hours** (configurable to 1-24h).
- **Retention 8 hours** (configurable to 8-720h).
- Restore by **opening a support ticket** — there's no
  self-service UI for Periodic restore.

Suitable for: dev / test workloads where occasional point-in-time
recovery is fine. Not suitable for production.

## Continuous backup (recommended)

What you get:

- **Point-in-time restore up to 30 days** via the Azure portal
  or REST API (self-service).
- **Continuous oplog-style backup** — restore granularity is
  per-second within the window.
- **No additional backup storage fees** for the first equivalent
  to the size of the database; more if you exceed it.
- Extra cost: ~30-50% on top of provisioned RU/s for the
  account.

### Enable continuous backup

**On account creation** is the easiest path — pick "Continuous
(7 days)" or "Continuous (30 days)" in the backup-policy section
of the create form.

To switch an existing Periodic account to Continuous:

```bash
az cosmosdb update \
  --resource-group davepi-rg \
  --name davepi-cosmos \
  --backup-policy-type Continuous \
  --continuous-tier Continuous30Days
```

This is **one-way** — once you switch to Continuous, you can't
go back to Periodic. Plan accordingly.

## Point-in-time restore

```bash
az cosmosdb restore \
  --resource-group davepi-rg \
  --target-database-account-name davepi-restored \
  --account-name davepi-cosmos \
  --restore-timestamp 2026-05-11T13:00:00Z \
  --location eastus
```

Creates a **new Cosmos account** at the requested timestamp. To
cut over production traffic, update the app's `MONGO_URI` to the
restored account's connection string.

Restore is per-account (or per-database in newer SKUs) — you
can't restore a single collection.

## Manual exports for off-Cosmos retention

Cosmos's built-in backup is region-bound to the Azure cluster.
For genuinely off-Azure retention (or > 30 day PITR), do periodic
`mongodump`-style exports:

```bash
# As an Azure Container Apps Job on a cron schedule:
mongodump \
  --uri "${MONGO_URI}" \
  --archive=/tmp/davepi.archive.gz \
  --gzip

az storage blob upload \
  --account-name acmebackups \
  --container-name davepi \
  --file /tmp/davepi.archive.gz \
  --name "davepi-$(date -u +%Y%m%d).archive.gz"
```

Schedule the job nightly via Container Apps jobs (cron) or an
Azure Function with a timer trigger.

## Cosmos-specific limits to know

- **Aggregation pipeline compatibility.** Some MongoDB
  aggregation operators aren't supported on Cosmos's Mongo API.
  After a restore, run your existing `_describe`-driven smoke
  tests to confirm declared aggregations still work — they should,
  but verify.
- **Index size limits.** Cosmos indexes have per-document size
  limits; a restored database that fits in MongoDB might not
  in Cosmos if certain index policies changed. Unusual but
  worth knowing.
- **Region pair restore.** If you've configured geo-replication
  to a second region, restore can target either region. Treat
  region failover as a special case of restore.

## Cosmos vs Atlas: backup-specific differences

| | Cosmos (Continuous) | Atlas |
|-|---------------------|-------|
| Max PITR window | 30 days | 7 days (longer via snapshot policy) |
| Restore in-place | No (new account) | Yes |
| Granularity | Per-second | Per-second |
| Geo-failover | Built into the account (global distribution) | Multi-region clusters |
| Self-service UI | Yes | Yes |
| Cost shape | +30-50% on RU | Included in M10+ tier |

The 30-day PITR window is Cosmos's biggest backup advantage.
For compliance regimes that require longer windows (1+ year),
combine Continuous backup with the nightly off-Azure export
above.

## See also

- [File-storage backup](/operations/backup/file-storage/)
- [Restore drill](/operations/backup/restore-drill/)
- [Azure deployment guide](/operations/deployment/azure/)
