---
title: Deploy to Render
description: Step-by-step deploy to Render. Web Service for the app, MongoDB Atlas for the DB (Render doesn't host Mongo itself). render.yaml blueprint for one-click bootstrap from the repo.
---

[Render](https://render.com) is a "deploy from git" PaaS similar
in shape to Railway, with first-party Postgres / Redis but **no
managed MongoDB**. The standard pattern: Render hosts the app,
MongoDB Atlas hosts the DB. Render's free tier suspends after
inactivity (cold start ~30s); the $7/mo Starter tier is the
practical floor.

## Quick reference

| | |
|-|-|
| Cost (small app) | $7/mo (Render Starter) + Atlas free tier |
| Managed Mongo? | No — external (MongoDB Atlas recommended) |
| Cold start? | Yes on free tier; no on Starter+ |
| TLS | Automatic on `*.onrender.com` + custom domains |
| Blueprint | Yes (`render.yaml`) |

## Prerequisites

- A Render account.
- A [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (free
  M0 tier is fine for small apps).
- The dAvePi project pushed to GitHub.

## Deploy

1. **Provision Atlas.** Create a free M0 cluster. Add a database
   user; allowlist `0.0.0.0/0` if you can't pin Render's egress
   IPs (Atlas allows IP allowlists, but Render's egress isn't a
   stable single IP on most plans). For production, use a
   private endpoint or pin a stable egress IP via a network-add-on.

2. **Create a Render Web Service.** New + → Web Service → connect
   the GitHub repo. Render auto-detects Node.

3. **Configure the service.** Build command: `npm install`. Start
   command: `npm start`. Health check path: `/healthz`.

4. **Set env vars.** Under the service's Environment tab:

   ```
   NODE_ENV=production
   MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/davepi
   TOKEN_KEY=<long random string>
   CORS_ORIGINS=https://your-frontend.example.com
   ```

   Render sets `PORT` itself; dAvePi reads it via the `PORT`
   env in `index.js`.

5. **Deploy.** First build runs on save. Render builds, deploys,
   and routes traffic once `/healthz` returns 200.

### One-click blueprint

Drop a `render.yaml` at the repo root:

```yaml
services:
  - type: web
    name: davepi
    runtime: node
    plan: starter
    buildCommand: npm install
    startCommand: npm start
    healthCheckPath: /healthz
    envVars:
      - key: NODE_ENV
        value: production
      - key: MONGO_URI
        sync: false        # set manually in dashboard
      - key: TOKEN_KEY
        generateValue: true
      - key: CORS_ORIGINS
        sync: false
```

Then "Deploy to Render" from the GitHub UI uses the blueprint to
provision the service in one click. `sync: false` keeps the
secret values out of the repo.

## Custom domain + TLS

Service → Settings → Custom Domain. Render provides the CNAME
target. Let's Encrypt cert provisions within ~minutes of DNS
propagation. Auto-renews.

## Backups

Atlas's free tier doesn't include continuous backup; the M10
($57/mo) tier does. On the free tier, schedule a `mongodump`
from a Render cron job:

- New + → Cron Job → same repo. Build command: `npm install`.
  Run command: a small Node script that runs `mongodump` and
  writes to S3.

Or upgrade Atlas to M10+ and use the built-in continuous backup
+ point-in-time recovery.

## Scaling

- **Vertical**: bump the Render plan (Starter → Standard → Pro).
- **Horizontal**: Render supports auto-scaling on Standard+
  plans. dAvePi is stateless; Atlas handles the database tier
  separately.
- **Atlas tier**: M0 (free) → M10 ($57/mo) is the practical
  step up. M10 unlocks continuous backup, point-in-time recovery,
  and meaningful storage / IOPS.

## Observability

- Logs: Render captures stdout, displays live + retains 30 days.
  Ship to external collectors via the log-drain integration
  (Datadog / Papertrail / Better Stack).
- Metrics: `/_metrics` is reachable from outside Render via the
  public URL; gate with `METRICS_TOKEN`. Configure Grafana Cloud
  to scrape it.

## See also

- [Backup & retention](/operations/backup/)
- [Observability](/operations/observability/)
- [Other deploy targets](/operations/deployment/)
