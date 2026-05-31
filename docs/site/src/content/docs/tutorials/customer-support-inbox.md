---
title: 2. Customer support inbox — mini-CRM in 25 minutes
description: Two collections with a relation, a beforeCreate hook for auto-tagging urgent tickets, and Slack queries that render as Block Kit tables.
---

Build a small services-business support inbox: customers, tickets,
a relation between them, and a lifecycle hook that auto-tags
urgent tickets. By the end you'll be asking Slack
*"what's open and urgent for the Acme account?"* and getting back
a rendered table.

**You'll learn**: relations, lifecycle hooks, the agent's
`render_table` tool, and aggregations.

**Time budget**: ~25 minutes.

## 0:00 — Scaffold

```bash
npx create-davepi-app support-inbox --template blank
cd support-inbox
docker compose up -d
npm start
```

Delete `schema/versions/v1/note.js` — we won't use it.

## 2:00 — Write the two schemas

`schema/versions/v1/customer.js`:

```js
module.exports = {
  path: 'customer',
  collection: 'customer',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'email', type: String, required: true },
    { name: 'company', type: String, searchable: true },
  ],
};
```

`schema/versions/v1/ticket.js`:

```js
module.exports = {
  path: 'ticket',
  collection: 'ticket',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'customerId', type: String, required: true },
    { name: 'subject', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'body', type: String, searchable: true },
    {
      name: 'status',
      type: String,
      enum: ['open', 'pending', 'closed'],
      default: 'open',
    },
    { name: 'opened_at', type: Date, default: Date.now },
  ],
  relations: {
    customer: { belongsTo: 'customer', localKey: 'customerId' },
  },
};
```

Save both. Open <http://localhost:5050/admin>. Notice that on
ticket forms the customer field is now a dropdown — the framework
read the `relations.customer` declaration and rendered a typeahead
auto-populated from the `customer` collection. Zero UI code. See
[Relations](/features/relations/).

## 5:00 — Seed three customers

Register and log in (see [Tutorial 1](/tutorials/habit-tracker/)
if you need the curl commands). Then through the admin UI, or by
curl:

```bash
TOKEN=$(curl -s -X POST http://localhost:5050/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"sup3rsecret!"}' | jq -r .accessToken)

for c in "Acme Corp" "Globex" "Initech"; do
  curl -s -X POST http://localhost:5050/api/v1/customer \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$c\",\"email\":\"hello@$(echo $c | tr A-Z a-z | tr -d ' ').com\",\"company\":\"$c\"}" > /dev/null
done
```

## 7:00 — Ask the agent to add a priority field

Open the project in Claude Code. Ask:

> Add a `priority` field to ticket (low / normal / high / urgent,
> default normal) and a `tags` array of strings.

Claude edits `schema/versions/v1/ticket.js`. Hot reload picks it
up. Verify in `_describe`:

```bash
curl -s http://localhost:5050/_describe \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.schemas[] | select(.path=="ticket").fields[] | select(.name | inside("priority,tags"))'
```

## 9:00 — Ask the agent to add an auto-tag hook

Same Claude session:

> Add a `beforeCreate` hook to ticket that auto-tags `urgent` if
> the subject contains 'down' or 'broken' (case-insensitive), and
> bumps the priority to `urgent` in that case.

Claude updates the schema with a `hooks.beforeCreate` function.
The result should look something like:

```js
hooks: {
  beforeCreate: async ({ input }) => {
    const subject = String(input.subject || '');
    if (/\b(down|broken)\b/i.test(subject)) {
      const tags = new Set([...(input.tags || []), 'urgent']);
      return { ...input, tags: [...tags], priority: 'urgent' };
    }
  },
},
```

The `before*` hook returning a value **replaces** the input that
gets persisted; returning `undefined` keeps it. See
[Hooks](/features/hooks/).

## 12:00 — Seed some tickets

Drop these in through the admin UI or by curl:

```bash
ACME=$(curl -s "http://localhost:5050/api/v1/customer?__q=acme" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.results[0]._id')
GLOBEX=$(curl -s "http://localhost:5050/api/v1/customer?__q=globex" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.results[0]._id')

curl -s -X POST http://localhost:5050/api/v1/ticket \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$ACME\",\"subject\":\"Cannot reset 2FA\",\"body\":\"Got locked out, need help.\"}"

curl -s -X POST http://localhost:5050/api/v1/ticket \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$ACME\",\"subject\":\"Production is DOWN!\",\"body\":\"Status page is red.\"}"

curl -s -X POST http://localhost:5050/api/v1/ticket \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$GLOBEX\",\"subject\":\"How do I export to CSV?\",\"body\":\"Looking for the option.\"}"

curl -s -X POST http://localhost:5050/api/v1/ticket \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$GLOBEX\",\"subject\":\"Search is broken on mobile\",\"body\":\"Results never load.\"}"
```

Check the admin UI: tickets with "DOWN" and "broken" in the
subject should have `priority: urgent` and `tags: ["urgent"]`
auto-applied. Tickets without those words shouldn't.

## 15:00 — Ask Claude for an aggregation

> Add an aggregation to ticket called `openByCustomer` that groups
> open tickets by customer and returns count per customer, sorted
> descending by count.

Claude appends:

```js
aggregations: [
  {
    name: 'openByCustomer',
    description: 'Open ticket count grouped by customer.',
    pipeline: [
      { $match: { status: 'open' } },
      { $group: { _id: '$customerId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ],
    cache: { ttlSeconds: 30 },
  },
],
```

You now have three surfaces for the same query:

- REST: `GET /api/v1/ticket/aggregations/openByCustomer`
- GraphQL: `ticketOpenByCustomer`
- MCP: `aggregate_ticket_openByCustomer`

See [Aggregations](/features/aggregations/).

## 17:00 — Install and configure the agent

```bash
npm install @davepi/agent
```

`.env.agent`:

```bash
DAVEPI_URL=http://localhost:5050
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
DAVEPI_BEARER=eyJ...    # your /login access token
```

Access tokens default to 15 minutes and service mode does NOT
refresh. For a 25-minute tutorial, set `ACCESS_TOKEN_TTL=2h` in
the davepi server's `.env` (not the agent's), restart davepi, and
log in again to get a 2-hour token. For production, switch to
[per-user auth mode](/surfaces/agent/#per-user-agent_auth_modeper-user)
(shown in [Tutorial 5](/tutorials/multi-tenant-bookings/)).

## 19:00 — Wire up Slack

Follow the [Slack-bot setup checklist](/tutorials/habit-tracker/#900--create-a-slack-bot)
from Tutorial 1. The only difference: name the app
`support-inbox-bot`. Add to `.env.agent`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_SOCKET_MODE=true       # if using socket mode
SLACK_APP_TOKEN=xapp-...     # if using socket mode
```

Start it:

```bash
set -a; source .env; source .env.agent; set +a
npx davepi-agent
```

## 22:00 — Ask the bot

DM the bot:

> What's open and urgent for the Acme account? Show as a table.

The agent:

1. Calls `search_customer` (or `list_customer` with `__q=acme`) to
   resolve "Acme" to a `customerId`.
2. Calls `list_ticket` with `filter: { customerId, status: 'open',
   priority: 'urgent' }`.
3. Calls `render_table` with the resulting rows.

In Slack you see a Block Kit table with columns subject /
priority / opened_at — rendered natively, not as ASCII.

Now try:

> Which customer has the most open tickets right now?

The agent reaches for `aggregate_ticket_openByCustomer`, gets back
the grouped result, joins the top `_id` against `get_customer`,
and replies: *"Acme Corp has 2 open tickets, the most of any
customer."*

One more:

> Show me a chart of ticket volume by status, all customers.

Agent groups in its head from `list_ticket` (or via an aggregation
if you have one), calls `render_chart` with a pie or bar spec.
Chart appears inline.

## 24:00 — Done

What you have:

- Two collections with a relation, hot-reloaded into REST + GraphQL
  + MCP + Swagger + admin SPA.
- A lifecycle hook the agent wrote that auto-tags + bumps
  priority on creation.
- An aggregation the agent wrote, available on all three surfaces.
- A Slack bot that resolves entities by name, runs aggregations,
  and renders tables and charts natively per channel.

Total schema code you wrote by hand: ~40 lines. Total non-schema
code: zero.

## What to read next

- **[Tutorial 3: E-commerce storefront widget](/tutorials/ecommerce-storefront-widget/)**
  — the same backend, two audiences, two auth modes.
- [Features → Hooks](/features/hooks/) — every lifecycle hook the
  framework supports.
- [Features → Aggregations](/features/aggregations/) — what's
  expressible in declared aggregations and what to push to a
  hook instead.
- [Features → ACL](/features/acl/) — field-level + document-level
  access control (the foundation for Tutorial 3).
