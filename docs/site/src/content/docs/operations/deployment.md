---
title: Deployment
description: Production posture — env vars, process supervision, MongoDB, file storage, and the things to disable in production.
---

dAvePi is a stock Node.js Express server. Anything you can run a
Node app on (Render, Fly, Railway, ECS, GKE, a bare VM) will host
it. There's no special build step — `node index.js` boots the
server.

## Environment

A complete production `.env`:

```bash
NODE_ENV=production
APP_NAME=acme-api
API_PORT=5050

# Mongo
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/davepi

# Auth
TOKEN_KEY=<long-random-secret>      # 32+ random bytes; rotate via downtime window
TOKEN_TTL=2h                        # JWT lifetime; default 2h

# Pagination
PAGE_SIZE=20

# Rate limits (per-IP, per-minute)
RATE_LIMIT_API_PER_MIN=600
RATE_LIMIT_AUTH_PER_MIN=10

# CORS
CORS_ORIGINS=https://app.example.com,https://admin.example.com

# Idempotency
IDEMPOTENCY_TTL_SECONDS=86400       # 24h, matches Stripe

# Storage (pick one)
STORAGE_BACKEND=s3                  # 'local' | 's3' | 'gcs'
STORAGE_S3_BUCKET=acme-davepi-uploads
STORAGE_S3_REGION=us-east-1

# Hot reload (off in production!)
HOT_RELOAD_SCHEMAS=false
```

`HOT_RELOAD_SCHEMAS=true` is gated on `NODE_ENV !== 'production'`
already — leaving it set in the env has no effect, but keep it
disabled to avoid confusion.

## Boot sequence

```
node index.js
  ↓
require('./app')               ← schema loop runs once
  ↓
mongoose.connect(MONGO_URI)    ← waits for ready event
  ↓
apolloServer.start()           ← Apollo composes schema
  ↓
app.listen(API_PORT)           ← REST + Swagger UI + /graphql up
```

The server is ready when it logs `listening on port <N>` (Pino
JSON line: `{ "msg": "listening", "port": 5050 }`). Use that line
for your platform's healthcheck-after-deploy hook.

## Process supervision

Use a real supervisor — `pm2`, `systemd`, your platform's runtime,
or container orchestration. **Don't** rely on `nodemon` in
production; `nodemon` is dev-only.

A minimal `systemd` unit:

```ini
[Unit]
Description=davepi
After=network.target

[Service]
Type=simple
User=davepi
WorkingDirectory=/opt/davepi
EnvironmentFile=/etc/davepi/.env
ExecStart=/usr/bin/node /opt/davepi/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Healthcheck

`GET /healthz` returns `{ status: "ok" }` plus Mongo connection
state. Wire it to your platform's liveness probe; pair with
`/_describe` (which also responds 200 when schemas are loaded) for
readiness.

## MongoDB

dAvePi runs against any MongoDB ≥ 5.0:

- Self-hosted (single node, replica set, sharded).
- MongoDB Atlas (recommended for managed).
- Cosmos DB with the Mongo API (works, but watch for missing operators in some Cosmos tiers).

The framework owns one **text index per searchable schema**, plus
the **unique idempotency index** on `idempotency_key`. Composite
indexes you declare in `compositeIndex` are managed by Mongoose at
boot. Don't add indexes manually unless you're sure they don't
conflict with the framework's.

For replicas, point the connection string at the cluster (the
driver handles failover). For sharded clusters, your shard key
should include `userId` for tenant locality.

## File storage

Three options, pick one per file field:

| Backend | Production fitness |
|---------|-------------------|
| `local` | Small / single-host setups. Files vanish if the host's disk does — pair with regular backups. |
| `s3` | Default for most production deploys. Public files use direct CDN URLs; private files use signed URLs with ~5min TTL. |
| `gcs` | Same posture as `s3`, on Google Cloud. |

Per-field config means you can mix — sensitive uploads to `local`
on an encrypted volume, public assets to `s3` behind CloudFront.

## TLS

Terminate TLS at your load balancer (ALB, Cloudflare, nginx). The
Node server speaks plain HTTP; offloading TLS keeps the cert lifecycle
out of the application.

If you must run TLS in-process, wrap with `https.createServer` in
`index.js` — but the standard pattern is "TLS-terminating LB in
front of a HTTP-only app."

## Production-disabled features

In `NODE_ENV=production`, the framework disables:

- **Hot reload** (`HOT_RELOAD_SCHEMAS` is ignored).
- **GraphQL playground** at `/graphql/`.
- **GraphQL introspection.**
- **Verbose error messages** — unknown errors reduced to `Internal server error`.

Override the GraphQL flags in `app.js` if you need introspection
in production (e.g. for an admin tool that reads the live schema).

## Logging

Pino JSON logs go to `stdout`. Pipe them to your platform's log
collector — Datadog, CloudWatch, Vector, Loki, etc. Sensitive
fields are redacted (`authorization`, `cookie`, `set-cookie`,
`*.password`, `*.token`).

Every request gets a `reqId` (UUID) carried through the request's
log scope and on the response header. Use it for correlation.

## Migrations

dAvePi's data migrations are document-level and CLI-driven — see
[Migrations](/operations/migrations/). Schema changes that don't
need backfill (adding a field, adding an index, adding an
aggregation) are applied at boot — the new schema loads, indexes
build, and you're done.

## Roll-out posture

For schema-only changes:

1. Push the new schema file.
2. Restart the server (or rolling-restart your fleet).
3. Mongoose builds new indexes in the background; Apollo recomposes; MCP tools refresh.

For changes that need a data backfill:

1. Push code that handles **both** old and new shapes (e.g. computed fields with fallbacks).
2. Roll out.
3. Run the migration via `npx davepi migrate <name>`.
4. Push code that drops the back-compat shim.

This is a standard expand-migrate-contract pattern. See
[Migrations](/operations/migrations/).

## See also

- [Migrations](/operations/migrations/) — the data-migration toolchain.
- [Backup & retention](/operations/backup/) — keeping the database recoverable.
- [Quickstart](/quickstart/) — local dev setup.
