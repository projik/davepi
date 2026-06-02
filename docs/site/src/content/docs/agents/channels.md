---
title: Channels
description: How the agent talks to end-users — HTTP /chat (SSE), Slack (@-mention + DM), and templates for Telegram / WhatsApp / embeddable widgets. The contract every channel implements.
---

A **channel** is a thin adapter between an external messaging
surface and the agent's `runTurn` orchestrator. Every channel does
the same four things:

1. Receive an inbound message from its platform.
2. Build a `channelCtx` identifying the conversation
   (`{ channel, channelUserId, conversationId, ... }`).
3. Drive `runTurn({ ..., channelCtx, history, userMessage, onEvent })`
   and stream events back.
4. Translate the structured `render` events into the platform's
   native UI (Block Kit, an SSE event, a Telegram photo, etc.).

The HTTP and Slack channels are first-class. Telegram, WhatsApp,
and an embeddable web widget ship as **stubs in
`lib/channels/templates/`** — one-screen recipes that mirror the
Slack shape so contributing a real one is one file plus the
platform SDK.

## HTTP channel

The default channel — always on unless `AGENT_HTTP_ENABLED=false`.
Two endpoints (plus link-flow endpoints in per-user mode):

| Endpoint                  | Notes                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| `GET /health`             | Liveness probe. Returns `{ ok, agent, auth }`.                       |
| `POST /chat`              | Chat endpoint. SSE-streaming by default; pass `"stream": false` for plain JSON. |
| `GET /link/:nonce`        | Per-user mode only. Serves the email/password HTML form.             |
| `POST /link/:nonce`       | Per-user mode only. Form submission; calls davepi `/login` server-side. |
| `POST /oauth/callback`    | Per-user mode only. Always 403 — retained as a loud refusal of an earlier insecure shape. |

### Request shape

```http
POST /chat
Content-Type: application/json

{
  "message": "What products do we have?",
  "history": [],
  "stream": true
}
```

- `message` (required) — the user's turn.
- `history` (optional) — array of `{ role: 'user' | 'assistant', content }`
  pairs. In service mode the client round-trips history itself; in
  per-user mode the agent loads persisted history from the
  `conversation` schema and this field seeds an empty session.
- `stream` (optional, default `true`) — SSE if true, JSON if false.

### Streaming response (SSE)

When `stream: true` the response is `text/event-stream`. Events:

| Event           | Payload                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `tool_call`     | `{ type: 'tool_call', name, args }` — fired when the model asks to call a tool.                  |
| `tool_result`   | `{ type: 'tool_result', name, result }` — the tool's return value.                               |
| `token`         | `{ type: 'token', text }` — one streaming chunk of the assistant's text.                         |
| `render`        | `{ type: 'render', payload: { type: 'table' | 'chart', ... } }` — structured visualisation.      |
| `cache`         | `{ type: 'cache', cacheReadInputTokens, cacheCreationInputTokens }` — Anthropic-only cache usage. |
| `final`         | `{ type: 'final', text, history }` — assembled reply + updated history.                          |
| `done`          | `{ ok: true }` — end of stream.                                                                  |
| `error`         | `{ code, message }` — mid-stream failure. Stream ends after this.                                |

### Non-streaming response (JSON)

```json
{
  "text": "Here are your top 5 products.\n…",
  "history": [
    { "role": "user", "content": "What products do we have?" },
    { "role": "assistant", "content": "Here are your top 5 products.\n…" }
  ],
  "events": [
    { "type": "tool_call", "name": "list_product", "args": {} },
    { "type": "tool_result", "name": "list_product", "result": {} },
    { "type": "render", "payload": { "type": "table", ... } },
    { "type": "final", "text": "...", "history": [ ... ] }
  ]
}
```

### CORS

```bash
AGENT_CORS_ORIGINS=https://app.example.com,https://staging.example.com
```

Comma-separated allowlist. With per-user mode you'll want the
session cookie to round-trip — the agent emits
`Access-Control-Allow-Credentials: true` automatically for any
allowed origin.

### A worked browser client

```html
<script type="module">
const r = await fetch('/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',                     // for the session cookie in per-user mode
  body: JSON.stringify({ message: 'show me last week\'s orders as a chart' }),
});
const reader = r.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  for (const frame of buf.split('\n\n')) {
    if (!frame.trim()) continue;
    const lines = frame.split('\n');
    const ev = lines.find(l => l.startsWith('event: '))?.slice(7);
    const data = JSON.parse(lines.find(l => l.startsWith('data: '))?.slice(6));
    if (ev === 'token') write(data.text);
    if (ev === 'render') renderTable(data.payload);     // your code
  }
  buf = buf.endsWith('\n\n') ? '' : buf.split('\n\n').pop();
}
</script>
```

The bundled demo at `packages/davepi-agent/demo/index.html` is a
fuller working example.

## Slack

The Slack channel turns on when `SLACK_BOT_TOKEN` is set. It uses
[`@slack/bolt`](https://slack.dev/bolt-js/concepts) under the hood
and listens for:

- **`app_mention`** in a channel → replies in thread.
- **`message.im`** (DM to the bot) → replies in the DM.

The conversation key is the thread (`channel::thread_ts`), **not**
the user — so two threads from the same person are distinct
transcripts and the [conversation schema](https://github.com/projik/davepi/blob/main/schema/versions/v1/conversation.js)
won't bleed context between them.

### Slack app setup checklist

1. Visit <https://api.slack.com/apps>, **Create New App → From
   scratch**. Name it; pick your workspace.
2. **OAuth & Permissions → Bot Token Scopes:**
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:write`
   - `users:read`
3. **Event Subscriptions → Subscribe to bot events:**
   - `app_mention`
   - `message.im`
4. **Transport** — pick one:
   - **Socket mode** (no public URL needed) — under *Basic
     Information* create an App-Level Token with `connections:write`.
     Set `SLACK_APP_TOKEN=xapp-...` and `SLACK_SOCKET_MODE=true`.
   - **HTTP mode** — expose the agent via `ngrok` (or your hosted
     URL) and set the Slack event URL to
     `https://<host>/slack/events`. Leave `SLACK_SOCKET_MODE=false`.
5. **Install the app** to your workspace. Copy the **Bot User OAuth
   Token** to `SLACK_BOT_TOKEN=xoxb-...` and the **Signing Secret**
   to `SLACK_SIGNING_SECRET=...`.
6. Start the agent. `@`-mention it in a channel or DM it.

### Render translation

| `render` payload     | Slack output                                                                            |
| -------------------- | --------------------------------------------------------------------------------------- |
| `type: 'table'`      | Block Kit section with a markdown table inside a mrkdwn block. Wide (>10 cols) → fenced code block. |
| `type: 'chart'`      | [QuickChart](https://quickchart.io) image URL embedded as an `image` block.             |

The model never gets to emit raw HTML or SVG — both render tools
take strictly-typed Zod payloads so a prompt-injected response
can't smuggle markup into Slack.

### Threading

Per-conversation history is kept **in-memory** keyed by `thread_ts`
in addition to the persisted conversation row. On a restart the
in-memory cache is cold but the persisted row is loaded on the next
turn, so context survives. The in-memory cache is intentionally
non-persistent — operators who want shared history across replicas
will want to disable it or wire a shared store.

### Per-user link flow on Slack

In per-user mode, the first `@`-mention or DM from an unlinked user
triggers `UnlinkedError` inside `runTurn`. The Slack channel
catches it and replies with the link URL:

```
Please link your account first: https://agent.example.com/link/abc123…
```

The user clicks, completes the email/password form on the agent
server, and the refresh token is stored against `slack:<user_id>`.
The next mention is linked. Slack's signed event payload is the
trust anchor — no cookie needed.

## Channel context (`channelCtx`)

Every channel passes the same shape to `runTurn`:

```js
{
  channel: 'slack',                       // or 'http', 'telegram', ...
  channelUserId: 'U12345',                // platform's id for the speaker
  conversationId: 'C0123::1700000000.000100', // per-thread scope, or channelUserId for HTTP
  signal: undefined,                      // optional AbortSignal (cron uses it)
}
```

- `channel` — short string. Becomes the prefix in
  `endUserKey = ${channel}:${channelUserId}` for the customer
  profile lookup.
- `channelUserId` — the platform's id. Slack user id, HTTP linked
  user id, Telegram chat id, etc.
- `conversationId` — the **persistence key**. Slack threads, HTTP
  logged-in user, Telegram chat. NOT the same as `channelUserId`:
  keying by user alone collapses every Slack thread and DM for one
  person into a single transcript, leaking context across them.
  Channels that have no sub-user concept (HTTP) reuse
  `channelUserId` for `conversationId`.
- `signal` — optional `AbortSignal`. Forwarded to MCP tool calls
  and the model stream so a lost cron lease can cooperatively stop
  the turn mid-flight.

The orchestrator hands `channelCtx` to the MCP client (so auth
picks the right identity in per-user mode) and to the
[conversation loader](/agents/personas-memory-skills/) (so history
and the frozen snapshot resolve to the right row).

## Building a custom channel

Telegram, WhatsApp, and an embeddable widget ship as stubs:

- `packages/davepi-agent/lib/channels/templates/telegram.js`
- `packages/davepi-agent/lib/channels/templates/whatsapp.js`
- `packages/davepi-agent/lib/channels/templates/widget.js`

Each is a one-screen recipe that mirrors the `http.js` / `slack.js`
shape — `channelCtx`, `runTurn`, render-event translation. To ship a
real channel:

1. **Listen for inbound messages** using your platform's SDK
   (`node-telegram-bot-api`, Meta's WhatsApp Cloud API, etc.).
2. **Derive `channelCtx`** from the inbound event. For platforms
   with a thread/conversation concept, set `conversationId` to
   that key (so the persisted transcript scopes correctly).
3. **Drive `runTurn`** from `../orchestrator`:

   ```js
   const { runTurn } = require('@davepi/agent/lib/orchestrator');
   const out = await runTurn({
     config, model, mcpClient,
     channelCtx,
     history: getHistoryFor(channelCtx.conversationId),
     userMessage: msg.text,
     onEvent: (evt) => {
       if (evt.type === 'token') append(evt.text);
       if (evt.type === 'render') renderToPlatform(evt.payload);
     },
   });
   ```

4. **Translate `render` events** to your platform's native UI:
   - `payload.type === 'table'` → a monospace block, an attached
     CSV, or your platform's native table primitive if it has one.
   - `payload.type === 'chart'` → a QuickChart URL embedded as a
     photo/image, or a downloaded PNG attached as a file.

5. **Handle `UnlinkedError`** in per-user mode by surfacing
   `err.linkUrl` to the user with platform-appropriate instructions.

The HTTP and Slack channels (`packages/davepi-agent/lib/channels/`)
are the canonical references; copy the patterns there. A typical
channel ends up being ~150 lines.

## Multiple channels in one process

Default behaviour: the agent process boots HTTP (always) and Slack
(if `SLACK_BOT_TOKEN` is set). They share the same `mcpClient`,
`auth`, and `model` instance, so a Slack user and an HTTP widget
user with the same backend identity see the same data.

To run only one, flip the on-switch:

```bash
AGENT_HTTP_ENABLED=false      # disable HTTP
SLACK_ENABLED=false           # disable Slack even if SLACK_BOT_TOKEN is set
```

To add a custom channel inside the same process, use the
[programmatic API](/agents/programmatic-api/) — `createAgent` gives
you the parts, your code wires the new channel in.
