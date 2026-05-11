---
title: Deploy to Fly.io
description: Step-by-step deploy to Fly.io. Auto-scales-to-zero by default (low idle cost), supports custom-region deploys, and has cheap egress. Pairs with MongoDB Atlas for the DB.
---

[Fly.io](https://fly.io) deploys Docker containers to lightweight
Firecracker VMs near your users. The free tier auto-scales to
zero when idle, which makes it the cheapest "running production"
deploy for low-traffic apps. Fly doesn't host MongoDB itself —
pair with Atlas, or run a Mongo container on a separate
internal-only Fly app.

## Quick reference

| | |
|-|-|
| Cost (small app) | $0-5/mo (autostops when idle) + Atlas |
| Managed Mongo? | No — external (Atlas recommended) |
| Cold start? | ~1s wake from autostop |
| TLS | Automatic on `*.fly.dev` + custom domains |
| Multi-region | Yes (one of Fly's strengths) |

## Prerequisites

- [`flyctl` installed](https://fly.io/docs/hands-on/install-flyctl/) (`brew install flyctl` on macOS).
- A Fly account (`fly auth signup` / `fly auth login`).
- A MongoDB Atlas cluster (or another reachable Mongo).

## Deploy

1. **Initialise.**

   ```bash
   cd your-davepi-project
   fly launch
   ```

   `fly launch` auto-detects the Node project, generates a
   `fly.toml`, and offers to deploy. Accept the defaults; the
   first deploy will fail because env vars aren't set yet —
   that's fine.

2. **Set secrets.**

   ```bash
   fly secrets set \
     MONGO_URI='mongodb+srv://user:pass@cluster.mongodb.net/davepi' \
     TOKEN_KEY="$(node -e 'console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))')" \
     CORS_ORIGINS='https://your-frontend.example.com'
   ```

3. **Edit `fly.toml`.** Pin `PORT` and the health check:

   ```toml
   [env]
     NODE_ENV = "production"
     PORT     = "8080"

   [http_service]
     internal_port = 8080
     force_https   = true
     auto_stop_machines  = true
     auto_start_machines = true
     min_machines_running = 0  # set to 1 to keep one warm

     [[http_service.checks]]
       method   = "get"
       path     = "/healthz"
       interval = "30s"
       timeout  = "5s"
   ```

4. **Deploy.**

   ```bash
   fly deploy --remote-only
   ```

   The deploy logs show the build + boot. When `/healthz` passes,
   traffic switches. App URL is `https://<app-name>.fly.dev`.

5. **Verify.**

   ```bash
   curl https://<app-name>.fly.dev/healthz
   ```

The repo's [shipped GitHub Actions deploy workflow](https://github.com/projik/davepi/blob/main/templates/_shared/.github/workflows/deploy.yml)
targets Fly.io by default — once `FLY_API_TOKEN` is set as a repo
secret, every push to `main` deploys automatically (gated behind
the `production` environment for manual approval).

## Custom domain + TLS

```bash
fly certs add api.example.com
# DNS: CNAME api -> <app-name>.fly.dev (or A/AAAA records Fly suggests)
fly certs show api.example.com   # watches the cert provision
```

## Backups

Atlas free tier (M0) doesn't include continuous backup; M10
does. For free tier, run `mongodump` from a Fly scheduled
machine (`fly machine run` with `--schedule`) and upload to a
bucket.

## Scaling

- **Vertical**: `fly scale vm shared-cpu-1x --memory 512` →
  `performance-1x` etc. as needed.
- **Horizontal**: `fly scale count 3` — three machines load-
  balanced. With `auto_stop_machines = true`, idle replicas
  stop automatically.
- **Multi-region**: `fly regions add fra sin` adds Frankfurt
  and Singapore. Fly's anycast router sends traffic to the
  nearest live machine. Mongo (Atlas) becomes the latency-
  bottleneck for far-from-DB regions; pair with Atlas's
  global cluster for matching geography.

## Observability

- Logs: `fly logs` streams stdout; Fly retains 5 days. Ship to
  external collectors via Fly's Datadog / Better Stack
  integrations.
- Metrics: Fly's built-in Grafana provides VM-level metrics for
  free. App-level metrics via `METRICS_ENABLED=true` + scrape
  through Fly's internal network with Grafana Cloud.

## See also

- [Backup & retention](/operations/backup/)
- [Observability](/operations/observability/)
- [Other deploy targets](/operations/deployment/)
