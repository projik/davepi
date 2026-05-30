# @davepi/agent

A chat agent that ships pre-wired against a [dAvePi](https://docs.davepi.dev)
backend. The agent connects to davepi's built-in MCP server, so every schema's
CRUD + relations + aggregations + audit + file ops are available as tools out
of the box — and **tenant isolation and ACL are enforced server-side**, not
in the prompt.

## What you get

- **HTTP `/chat`** endpoint with Server-Sent Events streaming.
- **Slack** bot via `@slack/bolt` (app mention + DM). Render tools translate
  to Block Kit tables and QuickChart images.
- **Telegram / WhatsApp / Embeddable widget** templates in
  `lib/channels/templates/` — stubs with a one-screen recipe for filling in.
- **OpenAI + Anthropic** providers via the Vercel AI SDK. Switch via
  `LLM_PROVIDER`.
- **Two auth modes**:
  - `service` — one JWT (or `X-Client-Id`) for the whole bot. Right for an
    anonymous storefront widget where every visitor sees the same role-scoped
    slice.
  - `per-user` — each channel user maps to a real davepi user via an
    OAuth-style link flow. Refresh tokens stored locally; access tokens
    minted on demand and cached.
- **Tool router** for backends with too many schemas: above the configured
  limit (default 40), the agent first picks a resource, then loads that
  resource's tools.
- **Structured render tools** (`render_table`, `render_chart`) so the model
  can ask for a visualization without each channel reinventing layout.

## ACL boundary — design rule

The JWT (or `X-Client-Id`) **is** the access boundary. The agent never
re-implements ACL checks and never tries to constrain results via prompt
text. If you want a service-account bot to only see "published" rows,
declare a `schema.acl.scope[role]` filter on the davepi side — the MCP
server applies it on every read and the agent never sees the filter
itself. The wrong pattern (and the one to avoid) is a broad service token
plus "only show user X's data" in the prompt; that's a confused-deputy
bug waiting to happen.

## Quick start

```bash
# In your davepi project, install the agent as a dev tool:
npm install @davepi/agent

# Minimal env:
export DAVEPI_URL=http://localhost:5050
export ANTHROPIC_API_KEY=sk-ant-...
export DAVEPI_BEARER=<long-lived-jwt-issued-by-/login>
# OR for anonymous reads via an apiClient role:
# export DAVEPI_CLIENT_ID=<client-id>

# Start the agent:
npx davepi-agent
# HTTP /chat is now listening on :5060

# Talk to it:
curl -N -X POST http://localhost:5060/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What products do we have?"}'
```

## Configuration (env)

Required:

| Variable          | Purpose                                           |
| ----------------- | ------------------------------------------------- |
| `DAVEPI_URL`      | Base URL of the davepi backend                    |
| `LLM_PROVIDER`    | `anthropic` (default) or `openai`                 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Provider key             |

Service auth (default) — set one of:

| Variable           | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `DAVEPI_BEARER`    | Long-lived JWT for a davepi user                 |
| `DAVEPI_CLIENT_ID` | Public client id for anonymous reads             |

Per-user auth:

| Variable                   | Purpose                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `AGENT_AUTH_MODE=per-user` | Switch on per-user mode                                                       |
| `AGENT_LINK_BASE_URL`      | Public base URL of the agent itself (where `GET /link/:nonce` is served)      |
| `AGENT_SESSION_SECRET`     | Required for HTTP per-user mode — HMAC key for the signed session cookie      |
| `AGENT_COOKIE_SECURE`      | `true` (default) — emits `Secure` on the session cookie. Set `false` for HTTP-only dev |
| `STORE_URL`                | Where to persist refresh tokens. `file:./davepi-agent-store.json` (default) or `memory:` |

Persona & memory (optional):

| Variable                            | Purpose                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AGENT_KEY`                         | Which agent this process is (e.g. `support`). Selects the `agentPersona` / `agentMemory` rows used as prompt slots. Unset → built-in default prompt and no persisted snapshot |
| `AGENT_PERSONA_CACHE_TTL_SECONDS`   | Per-process cache TTL for the persona lookup (default `60`). Set `0` to fetch on every turn (strict immediacy) |
| `AGENT_PERSIST_CONVERSATIONS`       | Persist history + the frozen prompt snapshot to davepi's `conversation` schema (default `true`). `false` keeps the channel-managed in-memory round-trip only |
| `AGENT_SESSION_IDLE_SECONDS`        | Idle gap after which a returning user is a **new** session and the snapshot is re-frozen, picking up memory/profile writes from the prior session (default `1800`) |
| `LLM_PROMPT_CACHING`                | Anthropic prompt caching on the frozen snapshot prefix (default `true`, Anthropic provider only). `false` to disable |

### Memory & the frozen snapshot

Once `AGENT_KEY` is set the agent reads a per-tenant **memory** row (`agentMemory`,
slow-changing facts about the account) and a per-end-user **profile** row
(`customerProfile`, preferences/notes — shared across the tenant's agents) and
folds them into the system prompt alongside the persona. These five slots are
**snapshotted once at session start and frozen** for the whole conversation, so
the prefix stays byte-stable and Anthropic prompt caching keeps hitting. The
agent self-authors memory/profiles through the schema-generated MCP tools (e.g.
`update_agentMemory`); because the snapshot is frozen, a write takes effect on
the **next** session, never mid-conversation.

**Live vs. remembered.** Treat memory/profile/persona as slow-changing
background that may be slightly stale — never as live system state. For anything
that changes (order status, ticket state, inventory, balances), the agent calls
a tool to read it fresh. Snapshotted text shapes tone and recall; it is never an
access-control or live-data mechanism (the JWT / client id remains the boundary).

Linking flow (per-user mode): on first contact from an unlinked user the
agent returns a one-time link URL (`<agent>/link/<nonce>`). The user opens
it, signs in via a small HTML form, and the agent calls davepi's
`POST /login` server-side to obtain the refresh token. The refresh token
never crosses the browser. For HTTP-channel users, link completion sets
an HMAC-signed `davepi_agent_session` cookie (HttpOnly, SameSite=Lax)
that `/chat` reads on every subsequent request. `/chat` ignores any
caller-supplied `channelUserId` — the cookie is the trust boundary.

Channels:

| Variable                | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `AGENT_HTTP_ENABLED`    | `true` (default) / `false`                             |
| `AGENT_HTTP_PORT`       | HTTP port (default 5060)                               |
| `AGENT_CORS_ORIGINS`    | Comma-separated allowlist                              |
| `SLACK_BOT_TOKEN`       | Enables the Slack channel when set                     |
| `SLACK_SIGNING_SECRET`  | Required when Slack is enabled (HTTP mode)             |
| `SLACK_APP_TOKEN`       | App-level token for socket mode                        |
| `SLACK_SOCKET_MODE`     | `true` to use socket mode                              |
| `SLACK_PORT`            | Slack HTTP port (default 5061)                         |

Tools:

| Variable                  | Purpose                                              |
| ------------------------- | ---------------------------------------------------- |
| `AGENT_TOOL_LIMIT`        | Above this many tools, switch to routed mode (40)    |
| `AGENT_INCLUDE_RENDER`    | Inject `render_table` + `render_chart` tools (true)  |

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
  userMessage: 'Show me last week\'s orders as a chart',
  onEvent: console.log,
});
```

## Slack setup checklist

1. Create a Slack app at https://api.slack.com/apps.
2. **OAuth & Permissions** scopes: `app_mentions:read`, `chat:write`,
   `im:history`, `im:write`, `users:read`.
3. **Event Subscriptions**: enable; subscribe to `app_mention` and
   `message.im`.
4. Install the app to your workspace; copy the **Bot User OAuth Token**
   to `SLACK_BOT_TOKEN` and the **Signing Secret** to `SLACK_SIGNING_SECRET`.
5. For local dev without a public URL, set `SLACK_SOCKET_MODE=true` and
   provide `SLACK_APP_TOKEN`.
6. Start the agent; `@`-mention it in a channel or DM it.

## Channels not yet shipped

`lib/channels/templates/telegram.js`, `whatsapp.js`, and `widget.js` are
checked-in stubs with the recipe for filling them in. They mirror the
`http.js` / `slack.js` shape — `channelCtx`, `runTurn`, render-event
translation — so contributing a real one is one file plus deps.

## License

ISC
