---
title: Troubleshooting
description: Common davepi agent failures and how to debug them — auth errors, stuck link flows, missing tools, cache misses, Slack 4xx, and provider-specific gotchas.
---

A checklist of the failures you're most likely to hit, with the
fix. The agent logs to `pino` — set `LOG_LEVEL=debug` for verbose
output, and check the logs **first** before guessing.

## Boot fails

### `LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set`

Self-explanatory. Set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`,
matching `LLM_PROVIDER`). Not needed for `ollama`.

### `LLM_PROVIDER=ollama requires LLM_MODEL`

Ollama has no universal default — every operator pulls their own
model. Set `LLM_MODEL` to the exact name you ran `ollama pull`
with:

```bash
ollama pull llama3.1
LLM_PROVIDER=ollama LLM_MODEL=llama3.1 npx davepi-agent
```

### `AGENT_SESSION_SECRET must be set when using per-user auth`

The HTTP channel signs its session cookie with this secret. Set it
to a high-entropy value:

```bash
AGENT_SESSION_SECRET=$(openssl rand -hex 32)
```

If you've left this unset in dev, every restart rotates the
implicit secret and invalidates every session cookie. Persist a
real one even in dev.

### `Slack channel enabled but SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET are missing`

Either set both, or set `SLACK_ENABLED=false` to opt out
explicitly. See [Channels → Slack](/agents/channels/#slack) for the
full bot setup.

### `Unknown auth mode: ...` / `Unknown LLM provider: ...`

Typo in `AGENT_AUTH_MODE` or `LLM_PROVIDER`. Valid values:

- `AGENT_AUTH_MODE`: `service` (default) or `per-user`.
- `LLM_PROVIDER`: `anthropic` (default), `openai`, or `ollama`.

## Chat returns errors

### `401 UNAUTHENTICATED` on every chat in service mode

The bearer expired or is invalid.

```bash
# Confirm the token still works against davepi directly:
curl -s http://localhost:5050/api/user/me -H "authorization: Bearer $DAVEPI_BEARER"
```

`{ error: { code: 'UNAUTHENTICATED' } }` → mint a fresh one. The
default `ACCESS_TOKEN_TTL` is 15 minutes; for development bump it
in your davepi server's `.env`. For production prefer per-user mode
or a long-lived agent JWT signed with `TOKEN_KEY`.

### `401 UNLINKED` with a `linkUrl`

Expected in per-user mode on first contact. Open the URL, complete
the email/password form, retry the chat. The link nonce is one-shot
and expires after 15 minutes — trigger a new chat to mint a fresh
one if the first expired.

If you get `UNLINKED` repeatedly on the same user, check the agent
log for warnings — `STORE_URL` might be `memory:` (loses tokens on
restart) or the file path might not be writable.

### `403 FORBIDDEN` writing memory / customer profile / proposing a persona patch

The agent's bearer was issued for a user without role `agent`.
Field-level ACL on the learning-layer schemas is keyed off this
role:

```bash
# Confirm the role on the user behind the agent's token:
curl -s http://localhost:5050/api/user/me -H "authorization: Bearer $DAVEPI_BEARER" | jq .roles
# Expect: ["agent"] (plus possibly other roles for human ops, but `agent` must be present)
```

Add the role with a one-time update from an admin token, or
register the agent's user with `roles: ['agent']` from the start.

### `404 link` on opening a link URL

The nonce was already consumed (someone hit the page and
submitted), or it expired (default 15 minutes). Trigger a fresh
chat as the same channel user to issue a new nonce.

### `403` on `POST /oauth/callback`

Expected. That endpoint was removed in PR #128 review (refresh
tokens in URL query strings leak via logs/referrer/history) and
retained only as a loud refusal. Use the `/link/:nonce` flow.

## Tool calls fail

### `Unknown resource: <name>` from `use_resource`

Routing is on (more than `AGENT_TOOL_LIMIT` MCP tools) and the
model asked for a resource that doesn't exist. The model usually
recovers by calling `list_resources` and trying again. If it
doesn't, the resource name parsing in
[`toolRouter.js`](https://github.com/projik/davepi/blob/main/packages/davepi-agent/lib/toolRouter.js)
might be misclassifying a tool — open an issue with the tool list.

### Tools don't appear at all

Confirm the MCP server is up:

```bash
curl -s http://localhost:5050/mcp \
  -H "authorization: Bearer $DAVEPI_BEARER" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should see a list of tools. If you don't:

- Confirm `DAVEPI_URL` is right and reachable from the agent host.
- Confirm `DAVEPI_MCP_PATH` (default `/mcp`) matches the davepi
  server's mount point.
- Check the davepi server logs for MCP wiring errors.

The agent caches the tool list on first use; if you added a schema
mid-process and want the agent to see it without a restart, send a
`tools/list_changed` notification from davepi (emitted automatically
on hot reload in dev) or call `mcpClient.refreshTools()` from the
programmatic API.

### MCP tool calls hang

The davepi MCP transport is stateless `StreamableHTTPServerTransport`,
so every call opens a fresh transport. If calls hang:

- Confirm the davepi server isn't itself stuck (long-running plugin
  in the request path?).
- Check for a network policy blocking the agent host from reaching
  `DAVEPI_URL`.
- If the agent is in a container, make sure `DAVEPI_URL` points to
  the host that's reachable from inside the container (often
  `host.docker.internal` rather than `localhost`).

## Slack issues

### Bot doesn't respond to `@`-mentions

1. Confirm the bot is **a member of the channel** you're mentioning
   it from. `/invite @your-bot` if not.
2. Confirm the **Event Subscriptions** include `app_mention` and
   `message.im`.
3. Confirm `SLACK_BOT_TOKEN` (starts `xoxb-`) and `SLACK_SIGNING_SECRET`
   are set correctly. The signing secret is the *Signing Secret* on
   the Basic Information page, **not** the *Verification Token*.
4. If using socket mode, confirm `SLACK_APP_TOKEN` (starts `xapp-`)
   and `SLACK_SOCKET_MODE=true`. The agent log should print
   `socket connected` on startup.
5. If using HTTP mode, confirm your event URL is reachable
   (`ngrok http 5061` or similar) and the URL ends with
   `/slack/events`.

### `invalid_blocks` or `invalid_arguments` from Slack

Usually a `render_table` with cells that have unusual characters or
a `render_chart` with an oversized Vega-Lite spec. The agent's
render tools cap rows at 500; check the model isn't dumping a
runaway listing. Open the agent log for the `render` payload and
inspect it.

### Slack 401 / `not_authed`

Token was rotated and the `SLACK_BOT_TOKEN` env is stale, or the
app was uninstalled from the workspace. Re-install and copy a fresh
bot token.

## Anthropic cache isn't hitting

`cache` events should fire on every turn with a non-zero
`cacheReadInputTokens` after the first turn of a session. If
they're always zero:

| Cause                                                          | Fix                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Provider isn't Anthropic                                        | OpenAI / Ollama don't use this caching primitive. Expected.                        |
| `LLM_PROMPT_CACHING=false`                                      | You turned it off. Unset or `=true` to re-enable.                                  |
| Every turn is a NEW session                                     | `AGENT_SESSION_IDLE_SECONDS=0` or very small. Bump it (default `1800`).            |
| Conversation isn't persisting (no stable `conversationId`)      | Service-mode HTTP has no `channelUserId` / `conversationId`, so it can't persist. Use per-user mode or pass an explicit `channelCtx` with `conversationId` programmatically. |
| Persona / memory was just rewritten and the prefix changed     | Snapshot is frozen *within* a session. Mid-session writes don't bust the cache; the cache rebuilds on the next session. Expected once.                |
| Tool list changed (hot reload, new schema)                      | Cache invalidates when the tool descriptions change. Expected after a hot reload.   |

## Conversation persistence

### History resets across restarts

Either `AGENT_PERSIST_CONVERSATIONS=false`, or you don't have a
stable `conversationId` (service-mode HTTP has none). In per-user
HTTP and Slack the conversation row should survive — confirm
`conversation` rows are being written:

```bash
curl -s http://localhost:5050/api/conversation \
  -H "authorization: Bearer $DAVEPI_BEARER" | jq '.results[] | .conversationId'
```

### `mid-session writes can't alter the in-flight prefix`

Working as intended. The frozen snapshot is captured **once at
session start** and held byte-stable for the whole conversation —
that's what makes the Anthropic cache hit, and what keeps
prompt-injection in a `customerProfile.notes` write from rewriting
this session's identity tier. Self-authored memory writes take
effect on the *next* session.

If a write *must* take effect mid-session (operational reasons), an
operator can force a new session by setting `lastTurnAt` to far in
the past on the conversation row — the next turn will re-snapshot.

## Ollama tool-calling issues

### Model ignores tools, hand-writes markdown tables

Smaller / older models often have weak tool-calling. Try:

- A model with better tool support: `llama3.1`, `qwen2.5` (work
  well). Smaller variants are flakier.
- `AGENT_TOOL_LIMIT=20` to force the [router](/agents/tools-and-rendering/#tool-router)
  earlier — a shorter tool list helps weaker models stay focused.
- A stricter `LLM_SYSTEM_PROMPT` that explicitly demands
  `render_table` for tabular data.

### `model not found` from Ollama

The `LLM_MODEL` you set doesn't match a pulled model. `ollama list`
to see what you've got; `ollama pull <model>` to fetch one.

### Tool-call parameters look mangled

Some Ollama models reject strict JSON-schema envelopes. The agent
already sets `compatibility: 'compatible'` on the OpenAI-compatible
client to relax this. If you're still seeing breakage with a small
model, the model itself is the limitation — try a larger one.

## "It works on my machine"

### Agent runs locally but not in production

Check, in order:

1. **`DAVEPI_URL`** — is it reachable from the production agent
   host? `curl $DAVEPI_URL/health` from the same network.
2. **Provider key** — `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set in
   production env (and not committed to a `.env` that didn't ship)?
3. **Service-mode bearer** — production deployment shouldn't be
   using a short-lived dev JWT. Mint a long-lived one or switch to
   per-user.
4. **CORS** — does `AGENT_CORS_ORIGINS` include the production
   front-end origin? Empty disables CORS entirely; an exact
   string match is required.
5. **Cookie security** — `AGENT_COOKIE_SECURE=true` (the default)
   means the session cookie is only sent over HTTPS. If the agent
   is fronted by HTTP, the cookie won't round-trip and per-user
   mode will look "stuck" — use HTTPS, or `AGENT_COOKIE_SECURE=false`
   for staging.
6. **`STORE_URL`** — `file:./...` is relative to the agent's cwd.
   In a container that cwd is rarely what you expect. Use an
   absolute path, mount a volume, or switch to `memory:` (and
   accept that restarts lose links).

### Reading the agent log

```bash
LOG_LEVEL=debug npx davepi-agent
```

Look for:

- `agent built` — startup info (provider, model id, auth mode).
- `mcp tool list loaded count=N` — confirms MCP is reachable.
- `prompt cache usage cacheReadInputTokens=X cacheCreationInputTokens=Y`
  — per-turn cache metrics.
- `snapshot fetch failed; omitting slot` — a persona/memory/profile
  fetch threw. Tenancy issue or schema not loaded.
- `conversation persist failed; history not saved this turn` —
  davepi rejected the write. Probably an ACL or validation issue.

## Still stuck?

Open an issue with:

- The exact env (with secrets redacted).
- The agent log at `LOG_LEVEL=debug`.
- The davepi server log for the same request window.
- The MCP tool list (`curl ... tools/list` as shown above).

[→ `@davepi/agent` issues](https://github.com/projik/davepi/issues)
