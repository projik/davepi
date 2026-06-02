---
title: Programmatic API
description: Use @davepi/agent as a library — createAgent, startAgent, runTurn, mcpClient — to embed the agent in your own Node process, mint per-tenant instances from one codepath, or build a custom channel.
---

The agent ships as a bin (`npx davepi-agent`), but every level
underneath is exported as a library so you can:

- Build a custom channel without forking the package.
- Mint per-tenant agents from one shared process.
- Drive a one-off agent turn from a worker, a test, or a notebook.
- Reuse the MCP client directly without the LLM at all.

The public surface lives in `@davepi/agent`'s top-level `index.js`:

```js
const {
  createAgent,
  startAgent,
  createHttpApp,
  runTurn,
  buildConfig,
  createScheduledHandler,
  runScheduledSkill,
} = require('@davepi/agent');
```

## `createAgent(overrides?) → { config, auth, mcpClient, model, modelId, provider, scheduledSkill }`

Builds the agent's parts **without** starting any channels. The
overrides argument is shallow-merged on top of the env-resolved
[config](/agents/configuration/).

```js
const agent = await createAgent({
  llm: { provider: 'openai', model: 'gpt-4o-mini' },
  auth: { mode: 'service', bearer: process.env.MY_TOKEN },
  agent: { key: 'support' },
});

agent.config;     // the resolved config tree
agent.auth;       // service or per-user auth strategy
agent.mcpClient;  // the MCP client
agent.model;      // the AI SDK LanguageModel
agent.scheduledSkill({ skill, slackChannel }); // shortcut to createScheduledHandler
```

Use this when you want the assembled parts but plan to wire the
channels yourself. Pair with [`runTurn`](#runturn) to drive a
single turn:

```js
const out = await runTurn({
  config: agent.config,
  model: agent.model,
  mcpClient: agent.mcpClient,
  channelCtx: { channel: 'my-channel', channelUserId: 'user-42' },
  history: [],
  userMessage: 'show me last week\'s orders as a chart',
  onEvent: (evt) => console.log(evt.type, evt),
});

console.log(out.text);     // the assistant's reply
console.log(out.history);  // updated history (use this on the next turn)
```

## `startAgent(overrides?) → { ...agent, http?, slack? }`

Builds the agent **and** boots every configured channel. This is
what `npx davepi-agent` calls.

```js
const handles = await startAgent({
  http: { port: 8080 },
});
// handles.http   → { app, server }   when HTTP is enabled
// handles.slack  → { app }           when Slack is enabled
```

## `createHttpApp({ config, model, mcpClient, auth }) → express.Application`

Returns the agent's Express app without binding a port — useful for
mounting on an existing server, or for `supertest`-style tests:

```js
const { createAgent, createHttpApp } = require('@davepi/agent');
const agent = await createAgent();
const app = createHttpApp(agent);

const server = http.createServer(app);
server.listen(0);
```

The app declares `/health`, `/chat`, and (in per-user mode)
`/link/:nonce` and `/oauth/callback` endpoints. See
[Channels → HTTP](/agents/channels/#http-channel) for the request /
response shape.

## `runTurn` {#runturn}

```ts
runTurn({
  config,            // from createAgent
  model,             // from createAgent
  mcpClient,         // from createAgent
  channelCtx,        // { channel, channelUserId, conversationId, signal? }
  history,           // [{ role, content }, ...] — seeds an empty session
  userMessage,       // string
  onEvent,           // (evt) => void — see event types below
  signal,            // optional AbortSignal
}) → { text, history }
```

One orchestration "run" — given a user message plus prior history,
stream the model's reply with tool calls driven through the MCP
client. The same function the HTTP and Slack channels call
internally.

### `onEvent`

```ts
type AgentEvent =
  | { type: 'tool_call', name: string, args: unknown }
  | { type: 'tool_result', name: string, result: unknown }
  | { type: 'token', text: string }
  | { type: 'render', payload: { type: 'table' | 'chart', ... } }
  | { type: 'cache', cacheReadInputTokens: number, cacheCreationInputTokens: number }
  | { type: 'final', text: string, history: Array<{role,content}> };
```

Fired in order. `tool_call` and `tool_result` flank every model
tool use. `token` is one streaming chunk. `render` is a structured
visualization request. `cache` carries Anthropic's prompt-cache
usage. `final` is the assembled reply + updated history at the end.

### Persisted vs. in-memory history

When `config.agent.persistConversations` is true (default) **and**
`channelCtx` has a stable `conversationId`, the orchestrator:

1. Loads the conversation row from davepi's `conversation` schema.
2. Uses the persisted `systemSnapshot` for slots 1–5 (or assembles a fresh one if the row is new / past the idle gap).
3. Uses the persisted `history` array, falling back to the passed
   `history` if the row has none.
4. Writes the updated history back to the row at the end of the
   turn.

Service-mode HTTP has no `channelUserId`, so it can't persist —
falls back to round-tripping `history` through the caller and
caching the snapshot in-process for the session.

[→ Personas, memory, and skills → Frozen snapshot](/agents/personas-memory-skills/#the-prompt-slot-model)

### Cancellation

`signal` is forwarded into MCP tool calls (via the `channelCtx` the
MCP client reads) and into the model stream's `abortSignal`. A
caller (cron lease, request abort, test cleanup) can stop a turn
cooperatively without leaking in-flight requests.

### Errors

`runTurn` catches `UnlinkedError` internally and surfaces a friendly
"please link" message + `unlinked: true` in the return. Every other
error bubbles up. Use the typed errors in `lib/errors.js`
(`ValidationError`, `UnauthorizedError`, `ForbiddenError`, etc.)
when throwing from a custom channel.

## `buildConfig(overrides?) → config`

The env + file + overrides resolver, exported so you can inspect
the resolved config without booting anything:

```js
const { buildConfig } = require('@davepi/agent');
const cfg = buildConfig({ llm: { provider: 'openai' } });

console.log(cfg.davepiUrl);     // resolves env var
console.log(cfg.llm.model);     // null → uses provider default at resolveModel time
```

## `createScheduledHandler({ agent, skill, slackChannel, ... })` and `runScheduledSkill(...)`

Build a `davepi-plugin-cron` handler around a named approved skill,
or run one ad-hoc. See [Proactive agents](/agents/proactive-agents/)
for the full surface.

## The MCP client

`agent.mcpClient` is a thin wrapper around the
`@modelcontextprotocol/sdk` HTTP client. Useful when you want to
call davepi directly without going through the LLM:

```js
const { normalizeMcpResult } = require('@davepi/agent/lib/mcpResult');

const raw = await agent.mcpClient.callTool(
  'list_order',
  { filter: { status: 'open' }, perPage: 50 },
  { channel: 'http', channelUserId: 'user-42' },
);

const orders = normalizeMcpResult(raw);
console.log(orders.results);
```

| Method                            | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `listTools(channelCtx?)`          | Fetch (and cache) the MCP tool list. Re-call after a hot reload.       |
| `refreshTools(channelCtx?)`       | Drop the cache and re-fetch.                                           |
| `callTool(name, args, channelCtx?)` | Invoke one MCP tool. Returns the raw MCP envelope.                   |
| `invalidateCache()`               | Drop the cache (no re-fetch).                                          |

### `normalizeMcpResult(raw) → object`

The MCP SDK returns results in an envelope with `content` parts. The
normaliser unwraps them into a plain object:

| Raw shape                                                | Normalised                              |
| -------------------------------------------------------- | --------------------------------------- |
| `{ content: [ { type: 'text', text: '{"results":[...]}'} ] }` | `{ results: [ ... ] }` (JSON parsed) |
| `{ content: [ { type: 'text', text: 'plain' } ] }`       | `{ text: 'plain' }` (unparsable JSON)   |
| `{ isError: true, content: [ ... ] }`                    | `{ error: true, content: [ ... ] }`     |

Always call this on raw results before reasoning about them — both
the orchestrator's tool adapter and the router go through it.

## A worked custom channel

Putting it together — a minimal Discord channel adapter:

```js
const { Client, GatewayIntentBits } = require('discord.js');
const { createAgent, runTurn } = require('@davepi/agent');

const agent = await createAgent();

const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const history = new Map(); // channelId → history[]

discord.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!msg.mentions.has(discord.user)) return;

  const text = msg.content.replace(/<@!?\d+>/g, '').trim();
  const channelCtx = {
    channel: 'discord',
    channelUserId: msg.author.id,
    conversationId: msg.channelId,
  };
  const h = history.get(msg.channelId) || [];

  let assembled = '';
  const out = await runTurn({
    config: agent.config,
    model: agent.model,
    mcpClient: agent.mcpClient,
    channelCtx,
    history: h,
    userMessage: text,
    onEvent: (evt) => {
      if (evt.type === 'token') assembled += evt.text;
      if (evt.type === 'render' && evt.payload.type === 'chart') {
        // post the QuickChart URL as a follow-up …
      }
    },
  });

  history.set(msg.channelId, out.history);
  await msg.reply(out.text || '…');
});

await discord.login(process.env.DISCORD_TOKEN);
```

~50 lines. The same shape works for any messaging platform.

## Embedding inside another Express app

```js
const express = require('express');
const { createAgent, createHttpApp } = require('@davepi/agent');

const app = express();
app.use('/marketing', publicSiteRouter);
app.use('/dashboard', dashboardRouter);

// Mount the agent at /assistant — the agent's app handles /chat
// (and /link in per-user mode) under that prefix.
const agent = await createAgent();
app.use('/assistant', createHttpApp(agent));

app.listen(8080);
```

Your `/marketing` site can include the agent widget pointed at
`/assistant/chat`; everything goes through one process.

## A dispatcher pattern (multi-tenant)

```js
const { createAgent, runTurn } = require('@davepi/agent');

const agentsByTenant = new Map();

async function getAgentForTenant(tenantId) {
  if (agentsByTenant.has(tenantId)) return agentsByTenant.get(tenantId);
  const tenant = await loadTenant(tenantId);
  const agent = await createAgent({
    auth: { mode: 'service', bearer: tenant.agentJwt },
    agent: { key: tenant.agentKey },
  });
  agentsByTenant.set(tenantId, agent);
  return agent;
}

app.post('/chat/:tenantId', async (req, res) => {
  const agent = await getAgentForTenant(req.params.tenantId);
  const out = await runTurn({ ...agent, ... });
  res.json(out);
});
```

One process, N tenants. Each tenant gets its own auth identity, its
own learning-layer rows, and its own `mcpClient` cache. Be careful
to bound the map size (LRU-evict cold tenants) if N is large.

## Testing

`@davepi/agent` exports the same building blocks the package's own
tests use. The repo's tests under `packages/davepi-agent/test/` are
worth reading as worked examples:

| Test                    | What it shows                                                      |
| ----------------------- | ------------------------------------------------------------------ |
| `orchestrator.test.js`  | Driving `runTurn` against a stubbed model and stubbed MCP client.   |
| `http-channel.test.js`  | `supertest` against `createHttpApp`.                                |
| `proactive.test.js`     | `createScheduledHandler` with a stub poster and a stub `_runTurn`. |
| `promptAssembly.test.js`| Asserting persona / memory / profile / skill rendering and the sanitizer. |
| `conversation.test.js`  | Frozen-snapshot semantics across sessions.                          |

Stubs are the right shape for the public API — `mcpClient` is a
plain object with `listTools` / `callTool`, `model` is whatever the
AI SDK accepts (the tests use `MockLanguageModelV1` from
`@ai-sdk/provider-utils`).
