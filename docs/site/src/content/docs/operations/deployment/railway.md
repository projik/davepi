---
title: Deploy to Railway
description: Step-by-step deploy to Railway, with the MongoDB add-on. The simplest "git push, get a URL" PaaS for a dAvePi project, including auto-generated SSL and per-PR preview environments.
---

[Railway](https://railway.app) is a "deploy from git" PaaS with
managed databases as add-ons. The deploy flow is: connect a
GitHub repo, Railway detects Node, picks up `npm start`, builds,
deploys. Mongo comes as a one-click add-on next to the service.

## Quick reference

| | |
|-|-|
| Cost (small app) | ~$5/mo (app) + Mongo add-on |
| Managed Mongo? | Yes (Railway add-on) — or external Atlas |
| Cold start? | No |
| TLS | Automatic on `*.up.railway.app`; bring-your-own for custom domain |
| PR previews | Yes (per-environment) |

## Prerequisites

- A Railway account.
- The dAvePi project pushed to GitHub.

## Deploy

1. **Create a new project**, point it at your GitHub repo, give
   Railway access. It auto-detects Node and proposes `npm install
   && npm start` — accept the defaults.

2. **Add a MongoDB add-on.** New service → Database → MongoDB.
   Railway provisions Mongo and exposes its connection string
   via the `MONGO_URL` reference variable.

3. **Wire env vars on the app service.** Go to the service's
   Variables tab and add:

   ```
   NODE_ENV=production
   MONGO_URI=${{MongoDB.MONGO_URL}}
   TOKEN_KEY=<long random string>
   API_PORT=${{PORT}}
   CORS_ORIGINS=https://your-frontend.example.com
   ```

   `${{MongoDB.MONGO_URL}}` and `${{PORT}}` are Railway variable
   references that resolve at runtime. Railway sets `PORT`
   itself; dAvePi's `index.js` honours it.

4. **Deploy.** Railway builds on push to your selected branch.
   First deploy takes ~3-5 minutes. The dashboard shows the
   public URL once `app.listen` fires.

5. **Verify.**

   ```bash
   curl https://your-app.up.railway.app/healthz
   ```

## Custom domain + TLS

In the service → Settings → Networking → Custom Domain. Add the
hostname, Railway provides the CNAME target. After the DNS
record propagates and the TLS cert provisions (Railway uses
Let's Encrypt), the domain serves the app.

## Backups

The Mongo add-on doesn't ship with automated backups on the
hobby tier. Two options:

1. **Move Mongo to Atlas.** Free tier includes continuous backup.
   Swap the `MONGO_URI` env var; remove the Railway Mongo
   add-on after migrating data with `mongodump | mongorestore`.
2. **Scheduled `mongodump` job.** Railway supports cron services
   — add a tiny container that runs `mongodump` and writes to S3
   on a schedule.

See [Backup & retention](/operations/backup/).

## Scaling

- **Vertical**: Railway exposes a per-service "Resources" slider
  for CPU and memory. Easy lever for moderate growth.
- **Horizontal**: Replicas are available on the Pro plan; the
  service must be stateless (dAvePi is). Mongo doesn't scale this
  way — promote to a larger DB tier or move to Atlas.
- **PR previews**: enable in service settings. Each PR gets its
  own Railway environment with a temporary Mongo. Cleans up on
  PR close.

## Observability

- Logs: Railway captures stdout; UI shows the live log. For
  long-term, ship to an external collector via Railway's Logflare
  integration.
- Metrics: enable `METRICS_ENABLED=true`, but the `/_metrics`
  endpoint isn't reachable from outside Railway by default. Pair
  with `METRICS_TOKEN` and a Grafana Cloud / Prometheus scrape
  job that hits the public URL.

## See also

- [Backup & retention](/operations/backup/)
- [Observability](/operations/observability/)
- [Other deploy targets](/operations/deployment/)
