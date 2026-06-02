---
title: Configuration
description: The full set of environment variables, file-config keys, and programmatic overrides accepted by @davepi/agent — with precedence rules and worked examples.
---

The agent reads config in this order, each layer overriding the
previous:

1. **Built-in defaults** (e.g. `LLM_PROVIDER=anthropic`, `AGENT_HTTP_PORT=5060`).
2. **File config** at the path in `DAVEPI_AGENT_CONFIG`, if set.
3. **Environment variables** (the documented `DAVEPI_*` / `AGENT_*` / `LLM_*` / `SLACK_*` names).
4. **Programmatic overrides** passed to `createAgent({ ... })` or
   `startAgent({ ... })`.

Tables below mark required vs. optional and call out the default.

## Required

| Variable                                  | Purpose                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `DAVEPI_URL`                              | Base URL of the davepi backend. Default `http://localhost:5050`.         |
| `LLM_PROVIDER`                            | `anthropic` (default), `openai`, or `ollama`.                            |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`    | Provider key. Not needed for `ollama`.                                   |
| One of `DAVEPI_BEARER` / `DAVEPI_CLIENT_ID` | Service-auth identity. Omit only when `AGENT_AUTH_MODE=per-user`.       |

## Davepi backend

| Variable          | Default         | Purpose                                                                 |
| ----------------- | --------------- | ----------------------------------------------------------------------- |
| `DAVEPI_URL`      | `http://localhost:5050` | Base URL of the davepi backend.                                   |
| `DAVEPI_MCP_PATH` | `/mcp`          | Path the MCP server is mounted at on the davepi backend.                |

## LLM providers

| Variable             | Default                      | Purpose                                                                 |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `LLM_PROVIDER`       | `anthropic`                  | `anthropic`, `openai`, or `ollama`.                                     |
| `LLM_MODEL`          | provider default             | Model id. **Required for `ollama`** — see below.                        |
| `LLM_SYSTEM_PROMPT`  | built-in default             | Override the operating-contract block (slot #2 in the prompt assembly). |
| `LLM_MAX_STEPS`      | `8`                          | Max tool-call loops per turn.                                           |
| `LLM_TEMPERATURE`    | provider default             | Float passed straight through.                                          |
| `LLM_PROMPT_CACHING` | `true` (Anthropic only)      | Cache the frozen snapshot prefix. No-op for OpenAI / Ollama.            |

Provider defaults:

| Provider    | Default `LLM_MODEL`                                                                 |
| ----------- | ----------------------------------------------------------------------------------- |
| `anthropic` | `claude-sonnet-4-5`                                                                 |
| `openai`    | `gpt-4o`                                                                            |
| `ollama`    | none — operators `ollama pull` their own model, so an explicit `LLM_MODEL` is required. |

### Ollama specifics

`LLM_PROVIDER=ollama` reuses the bundled `@ai-sdk/openai` provider
pointed at Ollama's OpenAI-compatible `/v1` endpoint, so there's no
extra dependency.

| Variable          | Default                          | Purpose                                                                                |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| `LLM_MODEL`       | (required)                       | The exact name you ran `ollama pull` with (e.g. `llama3.1`, `qwen2.5`).                |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1`      | Override for a remote Ollama or a reverse proxy.                                       |
| `OLLAMA_API_KEY`  | `"ollama"`                       | Set only when fronting Ollama with an auth proxy. Ollama itself ignores it.            |

Tool-calling fidelity depends on the model — `llama3.1` and
`qwen2.5` work well; smaller models may struggle when the backend
has many schemas. The [tool router](/agents/tools-and-rendering/#tool-router)
keeps the exposed surface under `AGENT_TOOL_LIMIT` regardless.

## Auth

| Variable                  | Default     | Purpose                                                                              |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `AGENT_AUTH_MODE`         | `service`   | `service` or `per-user`.                                                             |
| `DAVEPI_BEARER`           | —           | Long-lived JWT for service mode. Wins when both this and `DAVEPI_CLIENT_ID` are set. |
| `DAVEPI_CLIENT_ID`        | —           | Public client id (anonymous reads) for service mode.                                 |
| `AGENT_LINK_BASE_URL`     | —           | Public base URL of the agent itself (where `/link/:nonce` is served). Per-user only. |
| `AGENT_SESSION_SECRET`    | —           | HMAC key for the signed `davepi_agent_session` cookie. **Required for HTTP per-user.** |
| `AGENT_COOKIE_SECURE`     | `true`      | Emits `Secure` on the session cookie. `false` for HTTP-only dev.                     |
| `AGENT_ACCESS_TTL_SECONDS`| `900` (15 m)| How long an access token is cached before re-minting. Per-user mode only.            |
| `AGENT_REFRESH_SKEW_SECONDS` | `60`     | Refresh access tokens this far before expiry to absorb clock skew. Per-user only.    |
| `STORE_URL`               | `file:./davepi-agent-store.json` | Where to persist refresh tokens. `memory:` for ephemeral / tests.   |

[→ Auth modes](/agents/auth/)

## HTTP channel

| Variable             | Default     | Purpose                                                                  |
| -------------------- | ----------- | ------------------------------------------------------------------------ |
| `AGENT_HTTP_ENABLED` | `true`      | Set `false` to disable the HTTP channel entirely.                        |
| `AGENT_HTTP_PORT` / `PORT` | `5060`| HTTP listen port. `PORT` is read for hosted-platform conventions.        |
| `AGENT_CORS_ORIGINS` | —           | Comma-separated allowlist. Empty disables CORS headers.                  |

## Slack channel

| Variable               | Default | Purpose                                                                 |
| ---------------------- | ------- | ----------------------------------------------------------------------- |
| `SLACK_ENABLED`        | `true` when `SLACK_BOT_TOKEN` is set | Force-enable / disable.                            |
| `SLACK_BOT_TOKEN`      | —       | Bot User OAuth Token (`xoxb-...`). Enables the Slack channel when set.  |
| `SLACK_SIGNING_SECRET` | —       | Required when Slack is enabled in HTTP mode.                            |
| `SLACK_APP_TOKEN`      | —       | App-level token for socket mode (`xapp-...`).                           |
| `SLACK_SOCKET_MODE`    | `false` | `true` to use socket mode (no public URL needed).                       |
| `SLACK_PORT`           | `5061`  | Slack HTTP port when not in socket mode.                                |

[→ Channels → Slack](/agents/channels/#slack)

## Tools

| Variable               | Default | Purpose                                                                 |
| ---------------------- | ------- | ----------------------------------------------------------------------- |
| `AGENT_TOOL_LIMIT`     | `40`    | Above this many MCP tools, switch to routed mode.                       |
| `AGENT_INCLUDE_RENDER` | `true`  | Inject `render_table` + `render_chart` tools into the tool list.        |

[→ Tools and rendering](/agents/tools-and-rendering/)

## Persona, memory, conversation

| Variable                          | Default | Purpose                                                                                       |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `AGENT_KEY`                       | —       | Which agent this process is (e.g. `support`). Selects the persona / memory / skill rows.       |
| `AGENT_PERSONA_CACHE_TTL_SECONDS` | `60`    | Per-process cache TTL for the persona lookup. `0` to fetch every turn (strict immediacy).     |
| `AGENT_PERSIST_CONVERSATIONS`     | `true`  | Persist history + the frozen prompt snapshot to davepi's `conversation` schema.               |
| `AGENT_SESSION_IDLE_SECONDS`      | `1800`  | Idle gap after which a returning user is a NEW session and the snapshot is re-frozen.         |

`AGENT_KEY` is the on switch for the whole [learning layer](/agents/personas-memory-skills/).
Unset → no persona lookup, default prompt, zero-config.

## File config

Set `DAVEPI_AGENT_CONFIG=/path/to/agent.config.js` to load a JS or
JSON config from disk before env vars are applied. The file exports
an object shaped like the runtime config tree:

```js
// agent.config.js
module.exports = {
  davepiUrl: 'http://localhost:5050',
  agent: { key: 'support', personaCacheTtlSeconds: 30 },
  llm: { provider: 'anthropic', maxSteps: 12, temperature: 0.2 },
  auth: { mode: 'per-user', linkBaseUrl: 'https://agent.example.com' },
  http: { port: 5060, corsOrigins: ['https://app.example.com'] },
  slack: { socketMode: true },
  tools: { limit: 60, includeRender: true },
};
```

Env vars override matching keys; programmatic overrides win
overall. Use the file form when you want one place to edit config
in development and the env-var form in production.

## Programmatic overrides

```js
const { createAgent, startAgent } = require('@davepi/agent');

const agent = await createAgent({
  llm: { provider: 'openai', model: 'gpt-4o-mini', maxSteps: 4 },
  auth: { mode: 'service', bearer: process.env.MY_TOKEN },
  tools: { limit: 100 },
});
```

The overrides object is shallow-merged on top of the env-resolved
config — nested keys (e.g. `llm.maxSteps`) replace just the field,
not the whole sub-object. Use this seam to scope a sub-agent inside
a larger process (a multi-tenant dispatcher minting per-tenant
agents from one shared codepath).

[→ Programmatic API](/agents/programmatic-api/)

## Worked examples

### Anonymous storefront widget

```bash
DAVEPI_URL=https://api.example.com
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
DAVEPI_CLIENT_ID=pk_storefront_live_abc123
AGENT_CORS_ORIGINS=https://shop.example.com
AGENT_TOOL_LIMIT=20
```

The widget bundles `pk_storefront_live_abc123` in the SPA build; the
`apiClient` row on the davepi side carries `role: 'storefront'`
with `schema.acl.scope.storefront = { status: 'published' }` so only
published products / appointments are readable. The agent has no
JWT and cannot write.

### Per-user support bot, multi-tenant

```bash
DAVEPI_URL=https://acme.davepi.dev
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
AGENT_AUTH_MODE=per-user
AGENT_LINK_BASE_URL=https://support.acme.com
AGENT_SESSION_SECRET=$(openssl rand -hex 32)
STORE_URL=file:/var/lib/davepi-agent/acme-store.json
AGENT_KEY=support
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

`AGENT_KEY=support` selects the `agentPersona`, `agentMemory`, and
`skill` rows for the support agent within the (Acme-owned) tenant.
A sibling process with `AGENT_KEY=sales` runs the sales agent off
its own rows; both share Acme's `customerProfile` rows.

### Air-gapped / offline dev

```bash
ollama pull qwen2.5
LLM_PROVIDER=ollama
LLM_MODEL=qwen2.5
DAVEPI_URL=http://localhost:5050
DAVEPI_BEARER=eyJ...
AGENT_TOOL_LIMIT=20            # smaller surface helps local models
```

No outbound network. The Anthropic-specific prompt caching is a no-op.
