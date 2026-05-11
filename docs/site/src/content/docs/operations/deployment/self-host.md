---
title: Self-host (Docker Compose)
description: Production Docker Compose stack with dAvePi, MongoDB, and Caddy for automatic TLS. Works on any host that runs Docker — a $5 VPS, your homelab, a bare-metal server.
---

For a small-to-medium production app where you'd rather own the
infrastructure than depend on a SaaS, the simplest production
posture is **Docker Compose on a single host with Caddy in front**.
Three containers, automatic TLS via Let's Encrypt, persistent
volumes for Mongo data.

The repo ships a production-ready compose file at
[`deploy/docker-compose.prod.yml`](https://github.com/projik/davepi/blob/main/deploy/docker-compose.prod.yml)
that this guide drives.

## Quick reference

| | |
|-|-|
| Cost (small app) | ~$5-10/mo (VPS) + your time |
| Managed Mongo? | No — DB runs in a container next door |
| Cold start? | No — services stay up |
| TLS | Automatic via Caddy + Let's Encrypt |
| HA / multi-region | No (single host); upgrade to PaaS or cloud for that |

## Prerequisites

- A host with Docker + Docker Compose installed (any modern Linux VPS).
- A DNS A record pointing at the host's public IP.
- Ports 80 + 443 reachable on the host (open in the cloud firewall).

## Deploy

1. **Clone the repo on the host.**

   ```bash
   git clone https://github.com/projik/davepi.git
   cd davepi
   ```

2. **Configure env vars.**

   ```bash
   cp deploy/.env.example deploy/.env
   # Edit deploy/.env — set DOMAIN, ACME_EMAIL, TOKEN_KEY, CORS_ORIGINS.
   # Generate TOKEN_KEY with:
   #   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

3. **Boot the stack.**

   ```bash
   docker compose -f deploy/docker-compose.prod.yml \
     --env-file deploy/.env \
     up -d --build
   ```

   Caddy provisions a Let's Encrypt cert on first boot. Watch
   the logs (`docker compose logs caddy`) to confirm the
   challenge succeeds.

4. **Verify.**

   ```bash
   curl https://$DOMAIN/healthz
   # {"status":"ok",...}
   ```

   Open `https://$DOMAIN/api-docs` for Swagger; `/_describe` for
   the capability manifest.

## Custom domain + TLS

The `Caddyfile` reads `$DOMAIN` and `$ACME_EMAIL` from the
compose env. To add a second hostname (e.g. for the admin SPA),
edit `deploy/Caddyfile` and add another site block.

Reload Caddy after edits:

```bash
docker compose -f deploy/docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## Backups

The compose stack runs Mongo with a named `mongo-data` volume.
The simplest backup approach: a nightly `mongodump` cron on the
host that writes to a path your off-site backup tool already
collects.

```bash
# /etc/cron.daily/davepi-backup
#!/bin/sh
set -e
ts=$(date -u +%Y%m%dT%H%M%SZ)
docker compose -f /srv/davepi/deploy/docker-compose.prod.yml \
  exec -T mongo mongodump --archive --gzip \
  > /srv/backups/davepi-$ts.archive.gz
find /srv/backups -name 'davepi-*.archive.gz' -mtime +14 -delete
```

For restore, see [Backup & retention](/operations/backup/). For
heavier setups, point at MongoDB Atlas (continuous backup +
point-in-time recovery) by setting `MONGO_URI` in `deploy/.env`
and removing the `mongo` service from the compose file.

## Scaling

Single-host Compose tops out at one app replica + one Mongo node.
Upgrade paths in order of effort:

1. **More CPU / RAM on the host.** Vertical scaling is fine for
   most workloads in the few-requests-per-second range — dAvePi
   is stateless, Mongo is the bottleneck.
2. **Move Mongo to Atlas.** Drops the DB out of the compose file;
   point `MONGO_URI` at Atlas. Survives the host being rebuilt.
3. **Replicate the API container.** Run multiple `api` replicas
   behind Caddy's `lb_policy` upstream block. At this point
   you're approaching what the PaaS targets give you out of the
   box; consider whether the operational overhead is still worth
   it.
4. **Move to a cloud target.** See AWS / GCP / Azure guides.

## Observability

- **Metrics**: set `METRICS_ENABLED=true` and (recommended)
  `METRICS_TOKEN=<random>` in `deploy/.env`. Point your
  Prometheus / Grafana Agent / vmagent at `/_metrics` on an
  internal-only port.
- **Logs**: containers write JSON to stdout. `docker compose
  logs -f api | jq` for ad-hoc; ship to Loki / Datadog / etc. via
  a sidecar or the platform's log driver.
- **Tracing / errors**: wire OpenTelemetry / Sentry / Datadog APM
  via `node --require` flags — see
  [Observability](/operations/observability/).

## See also

- [Backup & retention](/operations/backup/) — `mongodump` cron,
  restore drills, retention sweeps.
- [Observability](/operations/observability/) — full per-stack
  recipes.
- [Other deploy targets](/operations/deployment/).
