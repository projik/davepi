---
title: Agent
description: '@davepi/agent — a chat agent that ships pre-wired against a davepi backend. HTTP /chat + Slack channels, OpenAI + Anthropic providers, service-account or per-user auth modes.'
---

`@davepi/agent` is a chat agent that ships pre-wired against a
davepi backend. It connects to davepi's
[built-in MCP server](/surfaces/mcp/) as a client, so every
schema's CRUD + relations + aggregations + audit + file ops are
available as tools out of the box. Tenant isolation and ACL are
enforced server-side, not in the prompt.

The package is the *interactive* counterpart to
[`@davepi/mcp`](https://github.com/projik/davepi/tree/main/packages/mcp).
Where `@davepi/mcp` is a stdio↔HTTP bridge that lets developer
tools like Claude Desktop talk to a davepi instance, `@davepi/agent`
is a process you run to host an end-user-facing chatbot: an HTTP
`/chat` endpoint, a Slack bot, an embeddable widget, etc.

:::tip
**Looking for the guide?** This page is the *reference* — env
vars, defaults, one-line examples. For task-shaped walkthroughs
(creating your first agent, authoring a persona, wiring Slack,
proactive runbooks, troubleshooting), start with the
[Agents](/agents/) section.
:::

## What you get

- **HTTP `/chat`** endpoint with Server-Sent Events streaming.
- **Slack** bot via `@slack/bolt` (app mention + DM). Render tools
  translate to Block Kit tables and QuickChart images.
- **Telegram / WhatsApp / embeddable-widget** channel templates as
  one-screen stubs in `lib/channels/templates/` — fill them in for
  your channel of choice.
- **OpenAI + Anthropic** providers via the Vercel AI SDK
  (`LLM_PROVIDER=anthropic` default; switch to `openai`).
- **Two auth modes**, selectable per deployment.
- **Tool router** for backends with too many schemas — above the
  configured limit the model picks a resource first, then calls
  into that resource's tools.
- **Structured render tools** (`render_table`, `render_chart`)
  injected client-side so the model has a channel-neutral way to
  ask for a visualisation.

## ACL boundary — design rule

The JWT (or `X-Client-Id`) **is** the access boundary. The agent
never re-implements ACL checks and never tries to constrain
results via prompt text. If you want a service-account bot to
only see "published" rows, declare a `schema.acl.scope[role]`
filter on the davepi side — the MCP server applies it on every
read and the agent never sees the filter itself.

The wrong pattern (and the one to avoid) is a broad service token
plus *"only show user X's data"* in the prompt. That's a
confused-deputy bug waiting to happen. See [ACL](/features/acl/)
and [Tenant isolation](/concepts/tenancy/).

## Install

```bash
npm install @davepi/agent
```

Minimum env to start:

```bash
DAVEPI_URL=http://localhost:5050
LLM_PROVIDER=anthropic          # or openai
ANTHROPIC_API_KEY=sk-ant-...    # or OPENAI_API_KEY
DAVEPI_BEARER=<long-lived-jwt>  # service-account auth, see below
```

Then:

```bash
npx davepi-agent
# HTTP /chat is now listening on :5060
```

For Slack and per-user mode, see the sections below.

## Auth modes

### Service-account (`AGENT_AUTH_MODE=service`, default)

One identity for the whole bot. Right for:

- Anonymous-storefront widgets (`DAVEPI_CLIENT_ID` paired with an
  `apiClient` row whose role has `schema.acl.scope[role]` filters).
- Internal bots that act as a shared service account.

| Variable           | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `DAVEPI_BEARER`    | Long-lived JWT for a davepi user                 |
| `DAVEPI_CLIENT_ID` | Public client id for anonymous reads             |

Bearer wins when both are configured — mirrors `middleware/clientAuth.js`.

**Note on access-token lifetime.** davepi's `/login` issues access
tokens with `ACCESS_TOKEN_TTL` (default `15m`). The agent in
service mode treats `DAVEPI_BEARER` as a *static* header — it does
**not** rotate via refresh tokens in this mode. For a quick local
demo you can set `ACCESS_TOKEN_TTL=2h` in your davepi server's
`.env`; for production, use per-user mode (below) or issue a
long-lived agent JWT signed with `TOKEN_KEY`.

### Per-user (`AGENT_AUTH_MODE=per-user`)

Each channel user maps to a real davepi user via a link flow. The
agent stores refresh tokens locally and mints access tokens on
demand, caching them just under the access-token TTL.

| Variable                   | Purpose                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `AGENT_LINK_BASE_URL`      | Public base URL of the agent itself (where `GET /link/:nonce` is served)      |
| `AGENT_SESSION_SECRET`     | Required for HTTP per-user mode — HMAC key for the signed session cookie      |
| `AGENT_COOKIE_SECURE`      | `true` (default) — emits `Secure` on the session cookie. Set `false` for HTTP-only dev |
| `STORE_URL`                | Where to persist refresh tokens. `file:./davepi-agent-store.json` (default) or `memory:` |

The flow:

1. First contact from an unlinked user returns a one-time link URL
   pointing at `<agent>/link/<nonce>`.
2. The user opens it; the agent serves a small HTML form
   (email + password).
3. Submission POSTs to `<agent>/link/<nonce>` server-side; the agent
   calls davepi's `POST /login` server-to-server.
4. The agent stores the resulting refresh token against
   `(channel, channel_user_id)`. The refresh token never crosses
   the browser.
5. For HTTP-channel users, the agent issues an HMAC-signed
   `davepi_agent_session` cookie (HttpOnly, SameSite=Lax). `/chat`
   reads the cookie on every subsequent request and ignores any
   body-supplied `channelUserId`.

Slack users are identified by Slack's signed event payload — the
platform is the trust anchor there. Telegram and WhatsApp adapters
follow the same pattern.

## LLM providers

| Variable          | Default     | Notes                                              |
| ----------------- | ----------- | -------------------------------------------------- |
| `LLM_PROVIDER`    | `anthropic` | or `openai`                                        |
| `LLM_MODEL`       | (provider default) | Override the model id                       |
| `LLM_SYSTEM_PROMPT` | (built-in) | Override the system prompt baked into every turn   |
| `LLM_MAX_STEPS`   | `8`         | Max tool-call loops per turn                       |
| `LLM_TEMPERATURE` | (provider default) | Float                                       |
| `LLM_PROMPT_CACHING` | `true` (Anthropic only) | Cache the frozen snapshot prefix       |

The Vercel AI SDK does the tool-loop orchestration. Adding a third
provider is a one-case switch in `lib/llm/index.js`.

## Channels

| Variable                | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `AGENT_HTTP_ENABLED`    | `true` (default) / `false`                             |
| `AGENT_HTTP_PORT`       | HTTP port (default `5060`)                             |
| `AGENT_CORS_ORIGINS`    | Comma-separated allowlist                              |
| `SLACK_BOT_TOKEN`       | Enables the Slack channel when set                     |
| `SLACK_SIGNING_SECRET`  | Required when Slack is enabled (HTTP mode)             |
| `SLACK_APP_TOKEN`       | App-level token for socket mode                        |
| `SLACK_SOCKET_MODE`     | `true` to use socket mode                              |
| `SLACK_PORT`            | Slack HTTP port (default `5061`)                       |

### Slack-bot setup checklist

1. Visit <https://api.slack.com/apps>, **Create New App** →
   **From scratch**. Name it; pick your workspace.
2. **OAuth & Permissions** → bot token scopes:
   `app_mentions:read`, `chat:write`, `im:history`, `im:write`,
   `users:read`.
3. **Event Subscriptions** → enable; subscribe to bot events
   `app_mention` and `message.im`.
4. Either **Socket Mode** (no public URL needed): toggle on; under
   **Basic Information** create an App-Level Token with
   `connections:write` → `SLACK_APP_TOKEN=xapp-...` and
   `SLACK_SOCKET_MODE=true`; **or** HTTP mode: expose the agent via
   `ngrok` and set the Slack event URL to
   `https://<ngrok>.ngrok-free.app/slack/events`.
5. Install the app to your workspace. Copy the **Bot User OAuth
   Token** to `SLACK_BOT_TOKEN=xoxb-...` and the **Signing
   Secret** to `SLACK_SIGNING_SECRET=...`.

## Tool router

Above `AGENT_TOOL_LIMIT` (default `40`) the agent switches to
routed mode. Instead of exposing every MCP tool to the model, it
exposes three meta-tools (`list_resources`, `use_resource`,
`call_mcp_tool`) plus the render tools. The model picks a resource
first (e.g. `appointment`) and then `call_mcp_tool` gates which
underlying tools it can invoke.

| Variable                  | Purpose                                              |
| ------------------------- | ---------------------------------------------------- |
| `AGENT_TOOL_LIMIT`        | Above this many tools, switch to routed mode (`40`)  |
| `AGENT_INCLUDE_RENDER`    | Inject `render_table` + `render_chart` tools (`true`) |

For backends with ~30 schemas (≈150+ tools) this is the difference
between *"the model picks the right tool 95% of the time"* and
*"the model gets lost in the menu."*

## Render tools

Two synthetic tools the model can call to ask for a structured
render:

- `render_table({ columns, rows, title? })` — channel adapter
  renders natively. HTTP/SSE: forwarded as a `render` event for
  the client. Slack: Block Kit table (markdown-table fallback for
  >10 columns).
- `render_chart({ vegaLiteSpec, title? })` — Vega-Lite v5 spec.
  Slack channel serialises to a QuickChart image URL.

These are validated by Zod so a prompt-injected response can't
smuggle raw HTML/SVG into a channel.

## Persona & memory (optional)

When `AGENT_KEY` is set the agent reads a per-tenant memory row
(`agentMemory`) and a per-end-user profile row (`customerProfile`)
and folds them into the system prompt at session start.

| Variable                            | Purpose                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AGENT_KEY`                         | Which agent this process is (e.g. `support`). Selects the persona / memory rows for prompt slots |
| `AGENT_PERSONA_CACHE_TTL_SECONDS`   | Per-process cache TTL for persona lookup (default `60`). `0` to fetch every turn                 |
| `AGENT_PERSIST_CONVERSATIONS`       | Persist history + frozen prompt snapshot to davepi's `conversation` schema (default `true`)      |
| `AGENT_SESSION_IDLE_SECONDS`        | Idle gap after which a returning user is a NEW session (default `1800`)                          |

The snapshot is frozen at session start so the prefix stays
byte-stable for Anthropic prompt caching. Treat memory/persona as
slow-changing background — never as live system state. For
anything that changes (order status, inventory), the agent calls a
tool to read it fresh; the JWT remains the access boundary.

## Programmatic use

```js
const { startAgent, runTurn, createAgent } = require('@davepi/agent');

// Start with all configured channels:
await startAgent();

// Or build the pieces and drive runTurn() yourself:
const { config, model, mcpClient, auth } = await createAgent({
  llm: { provider: 'openai', model: 'gpt-4o-mini' },
});
const out = await runTurn({
  config, model, mcpClient, auth,
  channelCtx: { channel: 'my-channel', channelUserId: 'user-123' },
  history: [],
  userMessage: 'show me last week\'s orders as a chart',
  onEvent: console.log,
});
```

`mcpClient.callTool(name, args, channelCtx)` is the low-level
entry point. Results come back in the MCP SDK envelope; normalise
them with the package's `normalizeMcpResult` helper:

```js
const { normalizeMcpResult } = require('@davepi/agent/lib/mcpResult');

const raw = await mcpClient.callTool(
  'list_employee',
  { filter: { slack_user_id: ctx.channelUserId }, perPage: 1 },
  ctx,
);
const employees = normalizeMcpResult(raw);
const emp = employees?.results?.[0];
```

## Extending the agent beyond davepi data

Today the agent talks to **one** MCP endpoint (davepi). To bring
in external capabilities (web search, vendor APIs, internal
knowledge bases) the cleanest pattern is to **expose those
capabilities through davepi itself**:

- Add a custom REST route on the davepi server that calls the
  external API. The auto-MCP layer exposes it to the agent as a
  tool. See [REST surface](/surfaces/rest/).
- Or write a davepi plugin that registers schemas + routes the
  agent can use.

This keeps the agent's tool surface uniform and lets you compose
external capabilities with the existing ACL / audit / tenancy
machinery. First-class support for multiple MCP endpoints (a
roadmap item) will simplify the wiring further.

## See also

- [`@davepi/agent` on GitHub](https://github.com/projik/davepi/tree/main/packages/davepi-agent)
- [Tutorial series](/tutorials/) — six end-to-end build-alongs
- [MCP server](/surfaces/mcp/) — the surface the agent consumes
- [ACL](/features/acl/), [Tenant isolation](/concepts/tenancy/)
