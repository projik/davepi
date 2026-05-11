---
title: Deploy to GCP (Cloud Run + MongoDB Atlas)
description: Step-by-step deploy to Google Cloud using Cloud Run for the app and MongoDB Atlas (with GCP VPC peering) for the database. Scales to zero by default — among the cheapest cloud deploys for low traffic.
---

The most cost-effective GCP shape for a small dAvePi production
deploy is **Cloud Run for the app + MongoDB Atlas on GCP for the
database**, with VPC peering between the two for private traffic.
Cloud Run scales to zero when idle (you pay only for active
requests + Atlas). Atlas (rather than a GCP-managed Mongo) gives
you the real MongoDB feature surface.

## Quick reference

| | |
|-|-|
| Cost (small app) | $0-10/mo (Cloud Run scales to zero) + Atlas M10 ($57/mo) |
| Managed Mongo? | MongoDB Atlas on GCP (no first-party GCP Mongo) |
| Cold start? | ~1-3s wake from zero |
| TLS | Automatic on `*.run.app` + custom domains |
| HA | Multi-region Cloud Run + multi-region Atlas |

## Prerequisites

- GCP project with billing enabled.
- `gcloud` CLI installed + authenticated.
- A MongoDB Atlas cluster running in GCP (M10+ to use VPC peering).
- A registered domain.

## Architecture

```
Internet → Cloud Run (TLS terminated by Cloud Run)
             ↓ (VPC connector)
           VPC (private network)
             ↓ (VPC peering)
           MongoDB Atlas cluster (same GCP region)
```

## Deploy

1. **Build + push the image to Artifact Registry.**

   ```bash
   gcloud auth configure-docker us-central1-docker.pkg.dev
   gcloud artifacts repositories create davepi \
     --location=us-central1 --repository-format=docker

   docker buildx build --platform linux/amd64 --target runner \
     -t us-central1-docker.pkg.dev/$PROJECT/davepi/api:latest \
     --push .
   ```

2. **Provision Atlas with VPC peering.** In the Atlas UI, create
   an M10+ cluster in GCP `us-central1` (or wherever). Network
   Access → Peering → create a peering connection to your GCP
   project's VPC. Accept the peering request on the GCP side.

3. **Set up a Serverless VPC Access connector.** This is what
   lets Cloud Run reach the peered VPC.

   ```bash
   gcloud compute networks vpc-access connectors create davepi-conn \
     --region=us-central1 \
     --network=default \
     --range=10.8.0.0/28
   ```

4. **Store secrets in Secret Manager.**

   ```bash
   echo -n "$(node -e 'console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))')" \
     | gcloud secrets create davepi-token-key --data-file=-

   echo -n 'mongodb+srv://user:pass@cluster.gcp.mongodb.net/davepi' \
     | gcloud secrets create davepi-mongo-uri --data-file=-
   ```

5. **Deploy to Cloud Run.**

   ```bash
   gcloud run deploy davepi \
     --image=us-central1-docker.pkg.dev/$PROJECT/davepi/api:latest \
     --region=us-central1 \
     --platform=managed \
     --vpc-connector=davepi-conn \
     --vpc-egress=private-ranges-only \
     --set-env-vars=NODE_ENV=production,PORT=4001,CORS_ORIGINS=https://your-frontend.example.com \
     --set-secrets=TOKEN_KEY=davepi-token-key:latest,MONGO_URI=davepi-mongo-uri:latest \
     --port=4001 \
     --min-instances=0 \
     --max-instances=10 \
     --allow-unauthenticated
   ```

6. **Verify.**

   ```bash
   curl $(gcloud run services describe davepi --region=us-central1 --format='value(status.url)')/healthz
   ```

## Custom domain + TLS

Cloud Run → Manage Custom Domains → Add Mapping. Verify domain
ownership in the Google Search Console (one-time). Add the
`AAAA`/`A`/`CNAME` records Cloud Run lists. TLS provisions
automatically.

Alternative: front Cloud Run with Cloud Load Balancing for a
custom-domain setup that supports IAM and global anycast.

## Backups

Atlas M10+ includes continuous cloud backups with point-in-time
recovery for ~24-hour windows; longer windows on higher tiers.
For off-cloud retention, schedule a Cloud Run Job that runs
`mongodump` and writes to a GCS bucket on a cron.

## Scaling

- **Cloud Run autoscaling**: `--min-instances` and
  `--max-instances` cap the range. dAvePi is stateless; any count
  works. Lift `min-instances` to 1+ if cold-start matters more
  than idle cost.
- **Concurrency**: `--concurrency=80` (default) — Cloud Run
  routes up to 80 concurrent requests to one container before
  spinning up another. Reduce if your app saturates CPU at lower
  concurrency.
- **Atlas tier**: M10 → M20 → M30 → ... vertical step-up. Sharded
  clusters at M30+.

## Observability

- **Logs**: stdout → Cloud Logging automatically. Filter by
  resource type `cloud_run_revision`. Export to BigQuery or
  Pub/Sub for downstream analysis.
- **Metrics**: Cloud Monitoring captures request count, latency,
  error rate per service. App-level metrics via
  `METRICS_ENABLED=true` + a Prometheus-on-GKE / Grafana Cloud
  scrape job.
- **Tracing**: Cloud Trace via OpenTelemetry — the OTel recipe at
  [Observability](/operations/observability/) plus the GCP
  exporter.

## See also

- [Backup & retention](/operations/backup/)
- [Observability](/operations/observability/)
- [Other deploy targets](/operations/deployment/)
