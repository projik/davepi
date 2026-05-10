---
title: Idea to deployed CRM in 10 minutes
description: A walkthrough — from npx create-davepi-app to a deployed CRM with admin SPA, in ten minutes flat.
---

This guide takes you from nothing to a running CRM with accounts,
contacts, deals (with a state machine), activities, an admin SPA,
and Claude Code wired in — all inside ten minutes.

The only prerequisites are Node 18+, Docker, and Claude Code.

## 0:00 — Scaffold

```bash
npx create-davepi-app acme-crm --template crm
cd acme-crm
```

The scaffolder picks the `crm` template, which ships with four
schemas (`account`, `contact`, `deal`, `activity`), a `.env`, a
`docker-compose.yml`, an `agent.md`, and a pre-configured `.mcp.json`.

```
acme-crm/
├── schema/versions/v1/
│   ├── account.js          ← Accounts (companies)
│   ├── contact.js          ← People at companies
│   ├── deal.js             ← Deals (with stage state machine)
│   └── activity.js         ← Calls / emails / meetings
├── docker-compose.yml      ← Mongo on 27017
├── .env                    ← TOKEN_KEY, MONGO_URI etc.
├── .mcp.json               ← Claude Code MCP wiring
├── agent.md                ← Conventions for the agent
└── package.json
```

## 1:00 — Boot

```bash
docker compose up -d         # Mongo
npm install                   # ~30s
npm start                     # binds to 5050 by default
```

You should see:

```
{"level":"info","msg":"listening","port":5050}
```

## 2:00 — Try the surfaces

Register a user, log in, hit `/api/v1/account`:

```bash
curl -s -X POST http://localhost:5050/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"sup3r-secret-pw!"}' | jq

TOKEN=$(curl -s -X POST http://localhost:5050/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"sup3r-secret-pw!"}' \
  | jq -r .accessToken)

curl -s http://localhost:5050/api/v1/account \
  -H "Authorization: Bearer $TOKEN" | jq
```

Empty results — there's nothing in the database yet. Let's seed.

## 3:00 — Seed sample data

```bash
npm run seed
```

You now have a few dozen accounts, contacts, and deals. The seed
script registers a `demo@example.com` user; log in as them or keep
using your own.

Open these in a browser:

| | |
|-|-|
| Swagger UI | <http://localhost:5050/api-docs> |
| GraphQL Playground | <http://localhost:5050/graphql/> |
| Capability manifest | <http://localhost:5050/_describe> |
| Admin SPA | <http://localhost:5050/admin> |

The admin SPA is built from the `_describe` manifest at startup —
forms, tables, and detail views are all rendered automatically
from the schema files.

## 4:00 — Add a custom field

Open `schema/versions/v1/deal.js` in your editor. Add a `region`
field:

```js
fields: [
  // ... existing fields ...
  { name: 'region', type: String, enum: ['NA', 'EMEA', 'APAC'], default: 'NA' },
],
```

Save. With `nodemon` running (`npm start`), the server picks up
the change in 50–150ms — no restart. The Apollo router rebuilds,
Swagger updates, MCP tools refresh, the admin SPA picks up the new
form field on next reload.

Verify:

```bash
curl -s http://localhost:5050/_describe | jq '.schemas[] | select(.path=="deal").fields[] | select(.name=="region")'
```

## 5:00 — Hand the keyboard to Claude Code

Open the project in Claude Code (`claude` from the project
directory). The pre-configured `.mcp.json` exposes the dAvePi MCP
server, and `agent.md` tells Claude the conventions.

Ask:

> Add a `lostReason` field to deal that's only populated when stage is
> `lost`, and an aggregation that groups `lost` deals by reason so I can
> see which ones we're losing most.

Claude reads the schema via the MCP `_describe` tool, drops a new
file or edits `deal.js`, and the framework picks it up live. The
new aggregation appears at:

- REST: `GET /api/v1/deal/aggregations/lostByReason`
- GraphQL: `dealLostByReason`
- MCP: `aggregate_deal_lostByReason`

Same source, three surfaces — see [Schema-driven generation](/concepts/schema-driven/).

## 6:00 — A state machine for deals

The `crm` template ships with a deal `stage` state machine
already — `prospect → qualifying → proposal → negotiation → won/lost`.
Try transitioning one:

```bash
DEAL_ID=$(curl -s "http://localhost:5050/api/v1/deal?__sort=createdAt:desc&__perPage=1" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.results[0]._id')

curl -s -X POST "http://localhost:5050/api/v1/deal/$DEAL_ID/transition" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"field":"stage","to":"qualifying"}' | jq
```

The response includes `availableTransitions.stage` so you know the
next step. Try an invalid transition:

```bash
curl -s -X POST "http://localhost:5050/api/v1/deal/$DEAL_ID/transition" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"field":"stage","to":"won"}' | jq
```

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Cannot transition stage from 'qualifying' to 'won'",
    "details": {
      "current": "qualifying",
      "attempted": "won",
      "allowed": ["proposal", "lost"]
    }
  }
}
```

The error is structured; agents can read `details.allowed` and
self-correct. See [State machines](/features/state-machines/).

## 7:00 — Deploy

Three deployment paths, pick what fits:

### Render

Push the repo to GitHub, then in Render:

```
New Web Service → connect repo → Node
Build Command:  npm install
Start Command:  node index.js
```

Add the env vars from your `.env` (with a fresh strong
`TOKEN_KEY`), point `MONGO_URI` at Atlas, and you're up.

### Fly.io

```bash
fly launch                    # picks Node, generates fly.toml
fly secrets set MONGO_URI=mongodb+srv://...  TOKEN_KEY=...
fly deploy
```

### Railway

```bash
railway init
railway up
```

Railway auto-detects Node and runs `node index.js`.

For all three, the [Deployment](/operations/deployment/) page has the
full env-var list and the `NODE_ENV=production` posture.

## 8:00 — Generate a typed TS client

For the frontend you're going to build next:

```bash
npx davepi gen-client --out ./client/davepi.ts \
  --base-url https://acme-crm.fly.dev
```

This produces a fully-typed client — every resource, every method,
every state-machine literal, every relation name, type-checked at
compile time. See [TypeScript client](/surfaces/client/).

```ts
import { createDavepiClient } from './client/davepi';

const api = createDavepiClient({
  baseUrl: 'https://acme-crm.fly.dev',
  getToken: () => localStorage.getItem('token') || '',
});

const won = await api.deal.list({ filter: { stage: 'won' } });
//                                          ^^^^^^^^
// 'won' is typed as a literal; 'wno' is a red squiggle.

await api.deal.transitionStage(dealId, 'proposal');
//                                       ^^^^^^^^^^
// Same — literal union of allowed states.
```

## 9:00 — Wire the admin SPA

Build it once:

```bash
cd ./node_modules/davepi/admin
npm install
npm run build
```

The build output lands at `<project>/admin/dist/`, which the
server picks up at `/admin`. The admin reads `_describe` at
startup and renders forms / tables / detail views for every loaded
schema. New schemas appear automatically on refresh — there's
nothing to wire up per-resource.

## 10:00 — Done

What you have now:

- A REST + GraphQL + MCP CRM with four schemas, deployed.
- A state machine on `deal.stage` with structured errors.
- An aggregation Claude added.
- A custom field you added.
- An admin SPA reflecting all of it without per-resource wiring.
- A typed TS client for the frontend you're about to build.

The framework didn't make any API design decisions for you that
your `schema/versions/v1/*.js` files didn't already imply.

## What to read next

- [Concepts: Schema-driven generation](/concepts/schema-driven/) — the model behind the magic.
- [Why agents come first](/concepts/agent-first/) — why Claude Code's experience is part of the design.
- [Tenant isolation](/concepts/tenancy/) — how `userId` and `accountId` keep User A out of User B's data.
- [Reference: Schema file shape](/reference/schema/) — every option you can declare.
