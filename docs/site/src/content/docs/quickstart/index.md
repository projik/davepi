---
title: Quickstart
description: Cold install to a running dAvePi server with auth + sample data in under a minute.
---

## What you'll need

- Node.js 18 or newer
- Docker (for local Mongo) — or any MongoDB connection string
- About 60 seconds

## 1. Scaffold

Pick a template that's closest to what you're building. `crm` is the most
fully-featured example; `blank` if you want to start empty.

```bash
npx create-davepi-app my-app --template crm
cd my-app
```

Templates available:

| Template | What you get |
|----------|--------------|
| `blank` | Minimal — one resource, full-text search. |
| `crm` | Accounts / contacts / deals (state machine) / activities. |
| `ticketing` | Tickets with two state machines + comments. |
| `content` | Articles (editorial workflow), categories, file uploads. |
| `b2b-saas` | Orgs / workspaces / invites / billing-event ledger. |

## 2. Boot Mongo

```bash
docker compose up -d
```

The scaffolder dropped a `docker-compose.yml` that runs MongoDB on the
default port. If you already have a Mongo connection string, edit the
`MONGO_URI` value in the generated `.env`.

## 3. Install + start

```bash
npm install
npm start
```

The server picks an unused port (default 5050; the scaffolder probes
and falls back if it's busy). The terminal prints the URL it
actually bound to.

## 4. Seed sample data

In another terminal:

```bash
npm run seed
```

This registers a demo user (`demo@example.com` / `demo-password!`)
and POSTs realistic sample records.

## 5. Try the surfaces

| Surface | URL |
|---------|-----|
| REST | `http://localhost:5050/api/v1/<resource>` |
| GraphQL playground | `http://localhost:5050/graphql/` |
| Swagger UI | `http://localhost:5050/api-docs` |
| Capability manifest | `http://localhost:5050/_describe` |
| Admin SPA | `http://localhost:5050/admin` (if built) |

For example:

```bash
TOKEN=$(curl -s -X POST http://localhost:5050/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"demo-password!"}' \
  | jq -r .accessToken)

curl -s http://localhost:5050/api/v1/account \
  -H "Authorization: Bearer $TOKEN" | jq '.results'
```

## 6. Wire Claude Code

The scaffolder dropped a `.mcp.json` with the MCP server pre-configured.
Open the project in Claude Code and ask:

> Add a `lostReason` field to deal that's only populated when stage is `lost`,
> and an aggregation that groups `lost` deals by reason.

Claude reads the schema, drops a new file under `schema/versions/v1/`,
and hot-reload picks it up — no restart.

## What's next

- Read [Concepts → Schema-driven generation](/concepts/schema-driven/) to
  understand how the surface stays in sync with your schemas.
- The [Schema reference](/reference/schema/) lists every option.
- The flagship guide [Idea to deployed CRM in 10 minutes](/guides/crm-in-10-minutes/)
  walks through extending a template into a production-ready CRM.
