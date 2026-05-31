---
title: 4. Real estate leads — the system has a heartbeat
description: Listings, leads, viewings, file uploads, a state machine for the lead funnel, and the slack plugin auto-posting new leads to a channel without you writing the glue.
---

You run a small real estate brokerage. You want listings with
photos, leads with a state machine, viewings linking them, and
your Slack to wake up when something interesting happens. The
agent watches the same data and answers analytics questions on
demand.

**You'll learn**: file uploads via `type: 'File'`, state machines,
the framework's record event bus, and how plugins compose without
glue code.

**Time budget**: ~45 minutes.

## 0:00 — Scaffold

```bash
npx create-davepi-app brokerage --template blank
cd brokerage
docker compose up -d
npm start
```

Delete `schema/versions/v1/note.js`.

## 2:00 — Three schemas

`schema/versions/v1/listing.js`:

```js
module.exports = {
  path: 'listing',
  collection: 'listing',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'address', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'neighborhood', type: String, searchable: true },
    { name: 'price', type: Number, required: true },
    { name: 'beds', type: Number, required: true },
    { name: 'baths', type: Number, required: true },
    { name: 'square_feet', type: Number },
    {
      name: 'status',
      type: String,
      enum: ['draft', 'active', 'pending', 'sold', 'withdrawn'],
      default: 'draft',
    },
    { name: 'description', type: String, searchable: true },
    {
      // Multi-file upload field. The framework handles multipart
      // upload, MIME validation, and a per-record file index.
      // For very large images, layer in davepi-plugin-object-storage
      // to do presigned PUT URLs instead of server-proxied uploads.
      name: 'photos',
      type: 'File',
      maxFiles: 12,
      allowedMime: ['image/jpeg', 'image/png', 'image/webp'],
    },
    { name: 'listed_at', type: Date, default: Date.now },
  ],
};
```

`schema/versions/v1/lead.js`:

```js
module.exports = {
  path: 'lead',
  collection: 'lead',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'email', type: String, required: true },
    { name: 'phone', type: String },
    { name: 'interested_in_listing_id', type: String },
    { name: 'source', type: String, enum: ['website', 'referral', 'open_house', 'cold_inbound'], default: 'website' },
    {
      name: 'stage',
      type: String,
      stateMachine: {
        initial: 'new',
        states: ['new', 'contacted', 'qualified', 'toured', 'closed_won', 'closed_lost'],
        transitions: {
          new: ['contacted', 'closed_lost'],
          contacted: ['qualified', 'closed_lost'],
          qualified: ['toured', 'closed_lost'],
          toured: ['closed_won', 'closed_lost'],
          closed_won: [],
          closed_lost: ['new'],
        },
      },
    },
    { name: 'notes', type: String },
    { name: 'created_at', type: Date, default: Date.now },
  ],
  relations: {
    listing: { belongsTo: 'listing', localKey: 'interested_in_listing_id' },
  },
};
```

`schema/versions/v1/viewing.js`:

```js
module.exports = {
  path: 'viewing',
  collection: 'viewing',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'leadId', type: String, required: true },
    { name: 'listingId', type: String, required: true },
    { name: 'scheduled_at', type: Date, required: true },
    { name: 'attended', type: Boolean, default: false },
    { name: 'feedback', type: String },
  ],
  relations: {
    lead: { belongsTo: 'lead', localKey: 'leadId' },
    listing: { belongsTo: 'listing', localKey: 'listingId' },
  },
};
```

Hot reload picks all three up. The admin SPA renders the
state-machine transition buttons for `lead.stage` automatically —
allowed-next-states comes from the schema, the UI doesn't have to
know them. See [State machines](/features/state-machines/).

## 7:00 — Seed listings (with photos)

Register, log in, then through the admin UI seed 4–5 listings.
For each one, upload 1–2 photos via the multi-file picker. The
framework stores them in Mongo's GridFS by default; for
production-scale buckets you'd add
[`davepi-plugin-object-storage`](https://github.com/projik/davepi/tree/main/packages/davepi-plugin-object-storage)
later.

Suggested seed values:

| Address                   | Neighborhood | Price   | Beds | Baths | Status   |
| ------------------------- | ------------ | ------- | ---- | ----- | -------- |
| 88 Park Slope Ave         | Park Slope   | 1250000 | 3    | 2     | active   |
| 412 Bushwick Pl           | Bushwick     | 875000  | 2    | 1     | active   |
| 11 Williamsburg Loft      | Williamsburg | 1800000 | 2    | 2     | pending  |
| 7 Brownstone Mews         | Park Slope   | 2400000 | 4    | 3     | active   |
| 99 Dumbo View Apt 12B     | Dumbo        | 1100000 | 1    | 1     | sold     |

## 12:00 — A few leads and viewings

Add ~10 leads through the admin UI, distributing them across
listings and stages:

- 4 in `new` (recent inbound).
- 3 in `contacted`.
- 2 in `qualified`.
- 1 in `toured` (yesterday — set `viewing` row with
  `attended: true`).

Add 2–3 viewings linking leads to listings, with `scheduled_at`
ranging from yesterday to next week.

## 16:00 — Install the slack plugin

The framework's plugin model wires plugins via `package.json`:

```bash
npm install davepi-plugin-slack
```

Add to your project's `package.json`:

```json
{
  "davepi": {
    "plugins": [
      "davepi-plugin-slack"
    ]
  }
}
```

Add to `.env`:

```bash
# Webhook URL from your Slack workspace's Incoming Webhooks app.
# Slack admin → Apps → Incoming Webhooks → Add to channel → copy URL.
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...

# Which CRUD events trigger a post. Comma-separated patterns
# matched against the `type` field on each record event.
SLACK_EVENT_PATTERNS=lead.created,lead.transitioned,viewing.created
```

This plugin is one-way notifications — a totally different shape
from the `@davepi/agent` package's interactive Slack bot. They're
complementary; you can run both. See
[`davepi-plugin-slack`](https://github.com/projik/davepi/tree/main/packages/davepi-plugin-slack)
for the full config surface.

Restart the davepi server (`Ctrl+C`, `npm start`). On boot you
should see a log line confirming the plugin loaded:

```
{"plugin":"slack","msg":"plugin loaded","events":["lead.created","lead.transitioned","viewing.created"]}
```

## 21:00 — Create a lead and watch Slack wake up

Add a new lead through the admin UI. Within ~1 second, your
configured Slack channel posts:

```
🆕 lead.created — name=Maya Chen, email=maya@example.com,
   interested_in=88 Park Slope Ave, stage=new
```

Transition that lead to `contacted` using the admin SPA's state
button. Slack channel posts the transition with `previous` and
`next` states. **You did not write that code.** The plugin
subscribed to the framework's `record` event bus
([Plugins](/features/plugins/), [Hooks](/features/hooks/)) and the
framework emits an event for every CRUD mutation including
state-machine transitions.

## 25:00 — Install the agent

```bash
npm install @davepi/agent
```

This brokerage has ~25 MCP tools (5 per resource × 3 resources +
relations + aggregations) — well under the default 40-tool limit,
so the tool router isn't engaged. If you add 4 more resources
later, set `AGENT_TOOL_LIMIT=80` or let the router kick in (the
agent picks a resource first, then loads that resource's tools).
See [Surfaces → Agent → Tool router](/surfaces/agent/#tool-router).

`.env.agent`:

```bash
DAVEPI_URL=http://localhost:5050
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# Service mode uses this bearer statically (no refresh-token rotation).
# For a 45-minute tutorial, set ACCESS_TOKEN_TTL=2h in the davepi
# server's .env and restart it before grabbing a fresh /login token.
DAVEPI_BEARER=eyJ...

SLACK_BOT_TOKEN=xoxb-...        # different from SLACK_WEBHOOK_URL above
SLACK_SIGNING_SECRET=...
SLACK_SOCKET_MODE=true
SLACK_APP_TOKEN=xapp-...
```

Set up the Slack bot using the
[checklist](/tutorials/habit-tracker/#900--create-a-slack-bot)
from Tutorial 1 if you don't have one for this app yet.

Start:

```bash
set -a; source .env; source .env.agent; set +a
npx davepi-agent
```

## 30:00 — Ask the agent to add an aggregation

Open Claude Code in the project:

> Add an aggregation to lead called `leadsByWeekAndStage` that
> groups leads by ISO week of `created_at` and by `stage`, sorted
> chronologically.

Claude adds:

```js
aggregations: [
  {
    name: 'leadsByWeekAndStage',
    description: 'Lead counts grouped by ISO week of created_at and current stage.',
    pipeline: [
      {
        $group: {
          _id: {
            year: { $isoWeekYear: '$created_at' },
            week: { $isoWeek: '$created_at' },
            stage: '$stage',
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.week': 1, '_id.stage': 1 } },
    ],
    cache: { ttlSeconds: 60 },
  },
],
```

Hot reload exposes it. New MCP tool: `aggregate_lead_leadsByWeekAndStage`.

## 33:00 — Three Slack moments

Open the bot's DM:

**Moment 1 — a filtered query.**

> Show me 3-bedroom active listings in Park Slope under $2M as a
> table.

Agent calls `list_listing` with the filter, calls `render_table`.
A Block Kit table appears with address / price / beds / baths.

**Moment 2 — the event-driven bit.** Open the admin UI in another
tab. Create a new lead. In ~1 second your *one-way* channel (the
plugin) posts the notification. The interactive bot is silent —
it only speaks when spoken to. Two complementary surfaces.

**Moment 3 — analytics.**

> Chart leads by week for the last quarter, broken down by stage.

Agent calls `aggregate_lead_leadsByWeekAndStage`, gets the grouped
result, and calls `render_chart` with a stacked-bar Vega-Lite
spec. The Slack channel serialises that to a QuickChart image
URL. You see a clean weekly stacked-bar chart of your funnel.

## 38:00 — Date math, no hooks needed

DM the bot:

> Which leads have been in `qualified` stage for more than 7 days
> without a scheduled viewing?

The agent:

1. Calls `list_lead` with `filter: { stage: 'qualified' }`.
2. For each lead, calls `list_viewing` with the lead id and
   `scheduled_at: { $gte: <now> }`.
3. Cross-references and renders the stale ones as a table.

That's three tool calls, choreographed by the model. You did not
write a query for this.

## 42:00 — File uploads via the agent (optional)

The framework's `type: 'File'` field exposes upload tools to MCP.
With Claude Code or another MCP client you can:

> Show me the photos for the 88 Park Slope listing.

Agent calls `list_listing_files` (an auto-generated tool for the
photos field), returns the URLs. In Slack, the URLs come back as
links; in the embeddable widget you could `<img src=...>` them.
See [Features → Files](/features/files/).

## 44:00 — Done

What you have:

- 3 collections with relations, a state machine, and multi-file
  uploads.
- A one-way Slack channel that wakes up on every CRUD event —
  zero glue code.
- An aggregation Claude wrote, exposed on REST + GraphQL + MCP +
  Swagger automatically.
- An interactive Slack bot answering filtered queries, doing
  multi-step lookups, and rendering analytics charts.
- Two Slack surfaces running side by side: the *passive*
  notification plugin and the *active* agent — different jobs,
  same workspace.

## What to read next

- **[Tutorial 5: Multi-tenant bookings](/tutorials/multi-tenant-bookings/)**
  — the agent stops just reading and starts *doing*. SMS,
  payments, multi-tenant ACL, and approval gates.
- [Features → State machines](/features/state-machines/)
- [Features → Plugins](/features/plugins/) — the model behind
  plugin composition.
- [Features → Files](/features/files/) — in-tree `type: 'File'`
  vs `davepi-plugin-object-storage` for large files.
