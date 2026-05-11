---
title: Deploy to Azure (Container Apps + Cosmos DB Mongo API)
description: Step-by-step deploy to Azure using Container Apps for the app and Cosmos DB with the MongoDB API for the database. Best fit when the rest of your estate is Azure or when you need the Cosmos-native global-distribution / RU model.
---

The standard Azure shape is **Container Apps for the app + Cosmos
DB with the MongoDB API for the database**. Container Apps gives
you Kubernetes-shaped deployment with managed autoscaling but
without the cluster overhead. Cosmos DB's MongoDB API is wire-
compatible with MongoDB (against a recent server version);
behaviour is mostly the same but the cost / capacity model is
Cosmos's request-unit (RU) accounting rather than CPU/IOPS.

## Quick reference

| | |
|-|-|
| Cost (small app) | $30+/mo (Container Apps min + Cosmos Serverless or 400 RU/s) |
| Managed Mongo? | Cosmos DB (Mongo API) — or pair with Atlas |
| Cold start? | Scale-to-zero supported but ~5-10s wake |
| TLS | Automatic on `*.azurecontainerapps.io` + custom domains |
| HA | Multi-zone in one region; multi-region via Cosmos global distribution |

## Prerequisites

- Azure subscription.
- Azure CLI (`az login`).
- An Azure Container Registry (or use Docker Hub).

## Architecture

```
Internet → Container Apps Environment ingress (TLS)
             ↓
           Container App revision (1+ replicas, autoscaling)
             ↓
           Cosmos DB (Mongo API) — virtual network endpoint
```

## Deploy

1. **Resource group + container registry.**

   ```bash
   az group create --name davepi-rg --location eastus

   az acr create --resource-group davepi-rg \
     --name davepiregistry --sku Basic --admin-enabled true
   ```

2. **Build + push the image.**

   ```bash
   az acr login --name davepiregistry
   docker buildx build --platform linux/amd64 --target runner \
     -t davepiregistry.azurecr.io/davepi:latest --push .
   ```

3. **Provision Cosmos DB (Mongo API).**

   ```bash
   az cosmosdb create \
     --resource-group davepi-rg \
     --name davepi-cosmos \
     --kind MongoDB \
     --server-version 7.0 \
     --capabilities EnableServerless
   ```

   Serverless is the cheapest starting tier — you pay per
   request unit. For predictable load, switch to provisioned
   throughput (400 RU/s minimum, ~$24/mo).

   Note the connection string:

   ```bash
   az cosmosdb keys list --resource-group davepi-rg \
     --name davepi-cosmos --type connection-strings \
     --query 'connectionStrings[0].connectionString' -o tsv
   ```

4. **Container Apps environment.**

   ```bash
   az containerapp env create \
     --resource-group davepi-rg \
     --name davepi-env \
     --location eastus
   ```

5. **Deploy the app.**

   ```bash
   az containerapp create \
     --resource-group davepi-rg \
     --name davepi \
     --environment davepi-env \
     --image davepiregistry.azurecr.io/davepi:latest \
     --target-port 4001 \
     --ingress external \
     --registry-server davepiregistry.azurecr.io \
     --secrets \
       mongo-uri="<the connection string from step 3>" \
       token-key="$(node -e 'console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))')" \
     --env-vars \
       NODE_ENV=production \
       PORT=4001 \
       MONGO_URI=secretref:mongo-uri \
       TOKEN_KEY=secretref:token-key \
       CORS_ORIGINS=https://your-frontend.example.com \
     --min-replicas 0 \
     --max-replicas 10
   ```

6. **Verify.**

   ```bash
   curl "https://$(az containerapp show --resource-group davepi-rg \
     --name davepi --query 'properties.configuration.ingress.fqdn' -o tsv)/healthz"
   ```

## Custom domain + TLS

Container Apps → custom domain → upload your TLS cert (or use
Azure-managed certs). Configure the DNS validation records the
portal lists.

## Backups

Cosmos DB takes periodic backups automatically (default 4-hour
intervals, 8-hour retention). For longer retention, switch the
backup policy to "continuous" in the Cosmos account settings —
that enables point-in-time restore up to 30 days.

For off-account retention, schedule a Container Apps Job that
runs `mongodump` and writes to Azure Blob Storage.

## Scaling

- **Container Apps**: configure scaling rules per replica (HTTP
  request count, CPU, memory, custom). `--min-replicas 0` is
  scale-to-zero; lift to 1+ to avoid cold starts.
- **Cosmos Serverless**: capacity scales with request rate; no
  manual scaling needed. The trade-off is per-request cost vs
  predictable monthly cost.
- **Cosmos Provisioned**: dial RU/s up/down. Auto-scale option
  scales between configured floor / ceiling.
- **Multi-region**: enable Cosmos global distribution to
  replicate the DB to other Azure regions. Replicate Container
  Apps to matching regions for latency-sensitive users.

## Observability

- **Logs**: stdout → Log Analytics workspace (configured on the
  Container Apps environment). Kusto queries for ad-hoc
  searching; ship to Datadog / Splunk via Event Hubs.
- **Metrics**: Container Apps built-in metrics (request count,
  latency, replica count). App-level `/_metrics` via the OTel
  recipe at [Observability](/operations/observability/).
- **Tracing**: Application Insights with the OTel collector
  sidecar.

## Cosmos vs Atlas trade-off

Cosmos (Mongo API) is wire-compatible with MongoDB but not
behaviourally identical:

- ✅ Global distribution + multi-region writes — one of Cosmos's
  killer features. No equivalent in Atlas.
- ✅ Tight Azure integration (Managed Identity, VNet, Private
  Endpoints).
- ⚠️ Request-unit cost model. Easy to over- or under-provision;
  RU accounting takes some practice.
- ⚠️ Some MongoDB operators / aggregation stages aren't
  supported, depending on the server version Cosmos exposes.

If your data shape leans on transactions, change streams across
collections, or specific aggregation operators, validate against
the current Cosmos Mongo API compatibility matrix before
committing — or pair Container Apps with MongoDB Atlas (on
Azure, via private endpoint) for real-MongoDB behaviour.

## See also

- [Backup & retention](/operations/backup/)
- [Observability](/operations/observability/)
- [Other deploy targets](/operations/deployment/)
