---
title: Getting started — your first agent
description: Boot a davepi agent against a local backend, chat with it over HTTP, and render a chart. Five minutes if you already have a davepi server running.
---

This walks you from a fresh checkout to a working chat in under
five minutes. It assumes:

- A local davepi server you can reach (e.g. `http://localhost:5050`).
  If you don't have one, do the [Quickstart](/quickstart/) first.
- An Anthropic API key (cheapest path; OpenAI and Ollama also work
  — see [Choosing a provider](#choosing-a-provider)).
- Node 18+.

The end state: an HTTP `/chat` endpoint streaming tokens, tool
calls, and rendered tables back to you over Server-Sent Events.

## 1. Get a JWT for the agent

Service auth is the simplest mode. The agent will use one bearer
token for every request. Register a user (skip this if you already
have one) and grab a JWT.

```bash
curl -s -X POST http://localhost:5050/register \
  -H 'Content-Type: application/json' \
  -d '{"first_name":"Agent","last_name":"Demo","email":"agent@example.com","password":"sup3rsecret!"}'

TOKEN=$(curl -s -X POST http://localhost:5050/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"agent@example.com","password":"sup3rsecret!"}' \
  | jq -r .accessToken)

echo "$TOKEN" | head -c 40 && echo
```

The access token's TTL defaults to 15 minutes. For a development
loop set `ACCESS_TOKEN_TTL=2h` in your davepi server's `.env` so
you're not minting a new token mid-session (`2h` is the policy
ceiling for access tokens). Production deployments should use
[per-user auth](/agents/auth/#per-user-mode) — the agent rotates
refresh tokens automatically and access tokens stay short-lived.

## 2. Install and configure

```bash
npm install @davepi/agent
```

Create a `.env` (or export these in your shell):

```bash
DAVEPI_URL=http://localhost:5050
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
DAVEPI_BEARER=<paste $TOKEN here>
```

That's the minimum. Everything else has a default.

## 3. Boot the agent

```bash
npx davepi-agent
```

You should see:

```
[INFO] agent built  provider=anthropic modelId=claude-sonnet-4-5 auth=service davepiUrl=http://localhost:5050
[INFO] davepi-agent http channel listening  port=5060 auth=service
```

## 4. Talk to it

```bash
curl -N -X POST http://localhost:5060/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What collections do we have? Show me as a table."}'
```

`-N` keeps curl from buffering — you'll watch tokens stream in. The
response is a sequence of SSE events:

```
event: tool_call
data: {"type":"tool_call","name":"list_resources","args":{}}

event: tool_result
data: {"type":"tool_result","name":"list_resources","result":{...}}

event: token
data: {"type":"token","text":"Here are the"}
...

event: render
data: {"type":"render","payload":{"type":"table","columns":[...],"rows":[...]}}

event: final
data: {"type":"final","text":"...","history":[...]}

event: done
data: {"ok":true}
```

If you want non-streaming JSON instead, pass `"stream": false` in
the body:

```bash
curl -X POST http://localhost:5060/chat \
  -H 'content-type: application/json' \
  -d '{"message":"hello","stream":false}' | jq
```

## 5. Try the render tools

The agent has two synthetic tools — `render_table` and
`render_chart` — it can call to ask for a structured visualization
without your channel having to reinvent layout.

```bash
curl -N -X POST http://localhost:5060/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Plot the count of records in each collection as a bar chart."}'
```

Watch for a `render` event with `payload.type === "chart"` carrying
a [Vega-Lite v5](https://vega.github.io/vega-lite/) spec. The
HTTP channel forwards the structured payload to your client (which
chooses its own renderer); the Slack channel translates it to a
QuickChart image.

[→ Tools and rendering](/agents/tools-and-rendering/)

## 6. Add Slack (optional)

Two more env vars and a Slack app, and the same agent process gets
a Slack bot. The fastest path on a laptop is socket mode (no public
URL needed):

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
SLACK_SOCKET_MODE=true
```

[→ Channels → Slack setup checklist](/agents/channels/#slack)

## Choosing a provider

| Provider    | Default model        | Needs                              | Notes                                                |
| ----------- | -------------------- | ---------------------------------- | ---------------------------------------------------- |
| `anthropic` | `claude-sonnet-4-5`  | `ANTHROPIC_API_KEY`                | Best tool-calling fidelity; prompt caching on by default. |
| `openai`    | `gpt-4o`             | `OPENAI_API_KEY`                   | Good tool-calling; no prompt-caching wiring (provider feature). |
| `ollama`    | none (must set `LLM_MODEL`) | A local Ollama server          | No API key, no network. Tool-calling quality depends on the model. |

```bash
# OpenAI
LLM_PROVIDER=openai OPENAI_API_KEY=sk-... npx davepi-agent

# Ollama (local)
ollama pull llama3.1
LLM_PROVIDER=ollama LLM_MODEL=llama3.1 npx davepi-agent
```

[→ Configuration → LLM providers](/agents/configuration/#llm-providers)

## Where to go next

You've got a working agent talking to a local davepi over service
auth. The natural next steps:

- **Give it a voice.** Add a [persona](/agents/personas-memory-skills/#persona--slot-1)
  row so the agent introduces itself as *Ada from Acme Support*
  instead of the generic default.
- **Ship Slack.** Walk the [Slack setup checklist](/agents/channels/#slack)
  and `@`-mention the bot from a channel.
- **Per-user auth.** If each end-user must see their own data only,
  switch to [per-user mode](/agents/auth/#per-user-mode).
- **Multi-tenant.** Run one agent process per tenant, or one
  process with `AGENT_KEY` per logical agent — see
  [Multiple agents per tenant](/agents/personas-memory-skills/#multiple-agents-per-tenant).
- **Schedule it.** Have the agent post a daily SLA digest with
  [proactive agents](/agents/proactive-agents/).
