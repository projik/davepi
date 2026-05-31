---
title: 1. Habit tracker — the 90-second wow
description: Single collection, single user, one chart. Ask the agent in Slack how you're doing this week and get back a Vega-Lite chart rendered as a Slack image.
---

The simplest possible loop end-to-end. One schema. One user. One
chart. By the end you'll be DMing a Slack bot *"how many workouts
this week?"* and getting back a chart rendered inline.

**You'll learn**: scaffolding, schema hot-reload, the agent's
`render_chart` tool, and the basic Slack wiring you'll reuse in
every subsequent tutorial.

**Time budget**: ~15 minutes if you've never done this before.

## 0:00 — Scaffold

```bash
npx create-davepi-app habit-tracker --template blank
cd habit-tracker
docker compose up -d    # local MongoDB on :27017
npm start               # server on :5050
```

The `blank` template ships with one example resource (`note`) which
we won't use — feel free to delete `schema/versions/v1/note.js`
once the server is running.

You should see:

```
{"level":"info","msg":"listening","port":5050}
```

## 2:00 — Write the workout schema

Create `schema/versions/v1/workout.js`:

```js
module.exports = {
  path: 'workout',
  collection: 'workout',
  fields: [
    { name: 'userId', type: String, required: true },
    {
      name: 'type',
      type: String,
      enum: ['cardio', 'strength', 'mobility', 'sport'],
      required: true,
    },
    { name: 'date', type: Date, required: true, default: Date.now },
    { name: 'duration_minutes', type: Number, required: true },
    { name: 'notes', type: String },
  ],
};
```

Save. With `nodemon` running, the server picks up the change in
~100ms — no restart. The admin SPA, REST routes, GraphQL types,
and MCP tools all rebuild automatically. See
[Hot reload](/concepts/hot-reload/).

## 3:00 — Register, log in, open the admin

```bash
curl -s -X POST http://localhost:5050/register \
  -H 'Content-Type: application/json' \
  -d '{"first_name":"You","last_name":"Demo","email":"you@example.com","password":"sup3rsecret!"}' | jq

TOKEN=$(curl -s -X POST http://localhost:5050/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"sup3rsecret!"}' \
  | jq -r .accessToken)
```

Open <http://localhost:5050/admin> in a browser. Sign in with the
same credentials. You'll see `workout` in the sidebar — click it,
hit **New**, add 5–10 sample rows. The form is auto-generated from
the schema; the `type` dropdown comes from the `enum`.

Quick seed via curl if you'd rather not click:

```bash
for i in 1 2 3 4 5 6 7; do
  TYPE=$(shuf -n1 -e cardio strength mobility sport)
  DAYS_AGO=$((RANDOM % 14))
  DATE=$(date -u -d "$DAYS_AGO days ago" -Iseconds 2>/dev/null \
        || date -u -v -${DAYS_AGO}d -Iseconds)
  curl -s -X POST http://localhost:5050/api/v1/workout \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"$TYPE\",\"date\":\"$DATE\",\"duration_minutes\":$((20 + RANDOM % 60))}" > /dev/null
done
```

## 5:00 — Ask the agent to extend the schema

Open the project in your editor with Claude Code (`claude` from
the project directory). The pre-configured `.mcp.json` exposes
the dAvePi MCP server. Ask Claude:

> Add a `mood` field to workout with values low / medium / high,
> and a `calories_burned` integer. Keep both optional.

Claude reads the current schema via the MCP `_describe` tool,
edits `schema/versions/v1/workout.js`, and the framework picks up
the change live. Verify:

```bash
curl -s http://localhost:5050/_describe \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.schemas[] | select(.path=="/api/v1/workout").fields[] | .name'
```

You should see `mood` and `calories_burned` in the list. The admin
form now has dropdowns / number inputs for them too — no UI code
to write.

## 7:00 — Install the agent

```bash
npm install @davepi/agent
```

Create `.env.agent` in the project root (or merge into your
existing `.env`):

```bash
# Where the agent reaches the davepi backend
DAVEPI_URL=http://localhost:5050

# LLM provider (anthropic | openai)
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Service auth: agent acts as YOU, the registered user.
# Grab the access token from the /login response above and paste it here.
# Access tokens default to 15 minutes; service mode does NOT auto-refresh.
# For this demo, bump the TTL by adding `ACCESS_TOKEN_TTL=2h` to the
# davepi server's .env (NOT this file) and re-running /login to get a
# 2-hour token. Restart davepi after changing .env.
# For production: issue a long-lived agent JWT signed with TOKEN_KEY,
# or switch to AGENT_AUTH_MODE=per-user (see Tutorial 5).
DAVEPI_BEARER=eyJ...
```

The full env-var catalogue is in the [@davepi/agent
README](https://github.com/projik/davepi/blob/main/packages/davepi-agent/README.md)
and exposed through `lib/config.js`.

## 9:00 — Create a Slack bot

Steps (do these once; reuse across tutorials):

1. Visit <https://api.slack.com/apps>, click **Create New App** →
   **From scratch**. Name it `habit-tracker-bot`, pick your
   workspace.
2. Under **OAuth & Permissions**, add bot token scopes:
   `app_mentions:read`, `chat:write`, `im:history`, `im:write`,
   `users:read`.
3. Under **Event Subscriptions**, toggle on, subscribe to bot
   events `app_mention` and `message.im`.
4. Choose your transport:
   - **Socket mode** (no public URL needed): under **Socket Mode**,
     toggle on; under **Basic Information**, scroll to **App-Level
     Tokens** and create one with `connections:write`. Add
     `SLACK_APP_TOKEN=xapp-...` and `SLACK_SOCKET_MODE=true` to
     `.env.agent`.
   - **HTTP mode**: expose your local agent via `ngrok` (the
     agent listens on `:5061` for Slack by default), then in
     Slack's **Event Subscriptions** set the URL to
     `https://<your-ngrok>.ngrok-free.app/slack/events`.
5. Install the app to your workspace. Copy the **Bot User OAuth
   Token** to `SLACK_BOT_TOKEN=xoxb-...` and the **Signing
   Secret** to `SLACK_SIGNING_SECRET=...`.

## 11:00 — Start the agent and DM it

```bash
# Load both env files
set -a; source .env; source .env.agent; set +a

npx davepi-agent
```

You should see:

```
{"level":"info","msg":"davepi-agent http channel listening","port":5060,"auth":"service"}
{"level":"info","msg":"davepi-agent slack channel listening (socket mode)"}
```

Open Slack, find your bot in the sidebar, DM it:

> How many workouts have I done this week?

The bot calls the MCP `list_workout` tool, filters by date, and
replies with a count plus a brief summary. Now try:

> Show me a chart of total duration by day for the last 14 days.

The agent calls `list_workout`, groups in its head (or via davepi's
aggregation tools), then calls the synthesised `render_chart`
tool with a Vega-Lite bar spec. The Slack channel adapter
serialises that to a QuickChart image URL and posts it inline.

If the chart isn't quite what you wanted, ask in plain English:

> Group by workout type instead, as a stacked bar.

The next reply has a stacked-bar chart. Same data, different ask,
no chart-library wrangling on your side.

## 13:00 — One last thing

Add a new workout in the admin UI — pick today, type "cardio",
30 minutes. Back in Slack, ask the bot again:

> How many workouts this week now?

The count is up by one. The agent is reading live data on every
turn — there's no caching of records, no sync. The `_describe`
tool tells it what's available; `list_workout` reads what's there
right now.

## 15:00 — Done

What you have:

- A single-schema dAvePi backend with REST + GraphQL + MCP +
  Swagger + admin SPA.
- A field added by Claude via MCP, picked up by hot reload.
- A Slack bot that answers questions about your data and renders
  charts on demand.

You wrote 13 lines of schema and zero lines of API / SDK / chart /
Slack-handler code.

## What to read next

- **[Tutorial 2: Customer support inbox](/tutorials/customer-support-inbox/)** — two
  collections, a relation, a hook, and table rendering in Slack.
- [Features → Hooks](/features/hooks/) — what other lifecycle
  hooks you can wire.
- [Surfaces → Agent](/surfaces/agent/) — the full agent config
  surface (auth modes, persona, memory, tool router).
- [Concepts → Schema-driven generation](/concepts/schema-driven/)
  — the model behind everything you saw above.
