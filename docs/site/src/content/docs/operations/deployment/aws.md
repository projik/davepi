---
title: Deploy to AWS (ECS Fargate + DocumentDB)
description: Step-by-step deploy to AWS using ECS Fargate for the app and DocumentDB for the Mongo-compatible database. The right shape for VPC isolation, IAM-based access control, and audit-log integrations.
---

For deployments where VPC isolation, IAM-based access control,
private networking, and audit-log integration with the rest of
the AWS estate matter, the canonical pattern is **ECS Fargate
for the app + DocumentDB for the database**, both inside a
private VPC, with an ALB doing TLS termination at the edge.

DocumentDB is AWS's Mongo-compatible managed database — same
wire protocol, slightly different feature set (notably no
multi-document transactions in older versions; check the
current compatibility matrix against your needs).

## Quick reference

| | |
|-|-|
| Cost (small app) | ~$50-100/mo (DocDB t3.medium + Fargate 0.25 vCPU + ALB) |
| Managed Mongo? | DocumentDB (Mongo-compatible) — or use Atlas via VPC peering |
| Cold start? | No |
| TLS | ACM cert on the ALB |
| HA | Multi-AZ (DocDB cluster + Fargate across AZs) |

## Prerequisites

- AWS account with admin or appropriately-scoped permissions.
- A registered domain in Route 53 (or wherever).
- ECR repo for the Docker image.

## Architecture

```
Internet → Route 53 → ALB (TLS terminated via ACM)
                       ↓
                     ECS Fargate service (2+ tasks across AZs)
                       ↓
                     DocumentDB cluster (private subnet, multi-AZ)
```

## Deploy

1. **Build + push the image to ECR.**

   ```bash
   aws ecr get-login-password --region us-east-1 \
     | docker login --username AWS --password-stdin \
       <account>.dkr.ecr.us-east-1.amazonaws.com

   docker buildx build --platform linux/amd64 \
     --target runner \
     -t <account>.dkr.ecr.us-east-1.amazonaws.com/davepi:latest \
     --push .
   ```

2. **Provision DocumentDB.** Console → DocumentDB → Create cluster.
   Pick a placement group across ≥2 AZs, instance class `db.t3.medium`
   for starter, attach to the VPC where ECS will run. Note the
   cluster endpoint and the auto-generated security group.

3. **Provision the ECS service.**

   - Task definition: Fargate, awsvpc network mode, your ECR
     image. Container port 4001. Set env vars (see below).
   - Service: place tasks in private subnets, attach to the ALB
     target group, allow the DocumentDB security group ingress
     from the ECS security group on port 27017.

   Env vars to set on the task definition:

   ```
   NODE_ENV=production
   MONGO_URI=mongodb://<user>:<pass>@<docdb-endpoint>:27017/davepi?tls=true&tlsCAFile=/etc/ssl/rds-combined-ca-bundle.pem&retryWrites=false
   TOKEN_KEY=<long random string from AWS Secrets Manager>
   PORT=4001
   CORS_ORIGINS=https://your-frontend.example.com
   ```

   `retryWrites=false` is required for DocumentDB. The TLS CA
   bundle must be baked into the image or fetched at boot — the
   AWS DocumentDB docs walk through the cert install.

4. **ALB + TLS.** Provision an ALB in public subnets, attach an
   ACM cert for your domain, point the listener at the ECS
   target group. Route 53 A-record (alias) → ALB DNS name.

5. **Verify.**

   ```bash
   curl https://api.example.com/healthz
   ```

### IaC

For anything beyond a one-off, write this with Terraform or AWS
CDK. The standard reference modules:

- [terraform-aws-modules/ecs](https://github.com/terraform-aws-modules/terraform-aws-ecs) for the Fargate service.
- [terraform-aws-modules/documentdb](https://registry.terraform.io/modules/cloudposse/documentdb-cluster/aws/latest) (community) for the cluster.

## Custom domain + TLS

ACM (us-east-1 for CloudFront, the ALB's region otherwise) →
request a cert for your domain. Validate via Route 53 DNS. Attach
to the ALB listener. Route 53 A-record alias → ALB.

## Backups

DocumentDB automatically takes daily snapshots with a 1-day
retention by default. Increase retention (up to 35 days) in the
cluster's Maintenance settings. For longer / off-account
retention, schedule a Lambda that copies snapshots to a different
account / region.

Alternative: use [MongoDB Atlas](https://www.mongodb.com/atlas)
via VPC peering. Atlas's continuous backup + point-in-time
recovery is more flexible than DocDB's snapshot model and the
feature parity with vanilla Mongo is better.

## Scaling

- **Fargate horizontal**: set up Application Auto Scaling on the
  ECS service — scale on CPU / memory / ALB request count.
  dAvePi is stateless, so any number of tasks works.
- **DocumentDB vertical**: change the instance class (t3.medium
  → r6g.large → ...). Read replicas via cluster add-replica.
- **DocumentDB sharding**: not supported on DocumentDB; if you
  need sharding, move to Atlas.

## Observability

- **Logs**: ECS → CloudWatch Logs. Configure a subscription
  filter to ship to Datadog / Splunk / Loki via Kinesis Firehose.
- **Metrics**: enable `/_metrics`, scrape from a Prometheus
  running inside the VPC. AWS-native: CloudWatch Container Insights
  + the AWS Distro for OpenTelemetry sidecar — the OTel recipe at
  [Observability](/operations/observability/) applies directly.
- **Tracing**: AWS X-Ray via the OTel collector sidecar.

## See also

- [Backup & retention](/operations/backup/)
- [Observability](/operations/observability/)
- [Other deploy targets](/operations/deployment/)
