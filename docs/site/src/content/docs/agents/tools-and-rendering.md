---
title: Tools and rendering
description: How the agent's tool surface is auto-derived from the davepi MCP server, when the tool router engages, and how render_table / render_chart give the model a channel-neutral way to visualise.
---

The agent's **tools** are the levers it can pull. Every tool is one
of three kinds:

| Kind          | Source                                       | When                                                                  |
| ------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| MCP tools     | Auto-derived by davepi from your schemas     | Always — these are the bread and butter (CRUD, relations, aggregations). |
| Router tools  | `list_resources`, `use_resource`, `call_mcp_tool` | Only when tool count exceeds `AGENT_TOOL_LIMIT`.                 |
| Render tools  | `render_table`, `render_chart`                | Injected client-side by the agent; opt out with `AGENT_INCLUDE_RENDER=false`. |

The model sees them all as one list — *"call this tool with these
arguments"* — and the agent's orchestrator routes the call to the
right handler.

## MCP tools (auto-derived)

For every schema in your davepi project, the MCP server exposes:

| Tool                                  | What it does                                                     |
| ------------------------------------- | ---------------------------------------------------------------- |
| `list_{path}`                         | Filter / paginate / sort. The agent's main read tool.            |
| `get_{path}`                          | Fetch by id.                                                     |
| `create_{path}`                       | Insert.                                                          |
| `update_{path}`                       | Patch by id.                                                     |
| `delete_{path}`                       | Delete (or soft-delete tombstone, if the schema has it).         |
| `restore_{path}`                      | Restore from soft-delete tombstone.                              |
| `transition_{path}`                   | Drive a state machine if the schema declares one.                |
| `search_{path}`                       | Full-text search if the schema has `searchable` fields.          |
| `count_{path}`                        | Bulk count under a filter.                                       |
| `history_{path}`                      | Audit-log replay if the schema has audit on.                     |
| `files_{path}`                        | File field operations.                                           |
| `{relation}_of_{path}`                | Relation-walk to a related resource.                             |
| `aggregate_{path}_{name}`             | A defined aggregation.                                           |

Tenant isolation, ACL, scope filters, validation, and audit are all
**server-side**. The agent doesn't reimplement any of it — it just
calls the tool.

[→ MCP server reference](/surfaces/mcp/)

### How the orchestrator adapts them

The agent talks to davepi over MCP at boot — fetches the tool list
once, caches it, and re-pulls on `tools/list_changed` notifications
(emitted by davepi on schema hot-reload). For each tool the
orchestrator builds an [AI SDK](https://sdk.vercel.ai/) `tool`
record:

```js
{
  description: '<from the MCP tool>',
  parameters: jsonSchema(<inputSchema from the MCP tool>),
  async execute(args) {
    const result = await mcpClient.callTool(name, args, channelCtx);
    return normalizeMcpResult(result);
  }
}
```

`normalizeMcpResult` unwraps the MCP response envelope (text parts,
JSON-encoded payloads) into a plain object the model can reason
about.

### Custom tools beyond davepi

Today the agent talks to **one** MCP endpoint (davepi). The cleanest
pattern to bring in external capabilities (web search, vendor APIs,
internal KBs) is to **expose those capabilities through davepi
itself**:

- Add a custom REST route on the davepi server that calls the
  external API. The auto-MCP layer exposes it to the agent as a
  tool. See [REST surface](/surfaces/rest/) and
  [schema-driven generation](/concepts/schema-driven/).
- Write a davepi plugin that registers a schema + routes the agent
  can use.

Both keep the agent's tool surface uniform and let you compose
external capabilities with the existing ACL / audit / tenancy
machinery. First-class support for multiple MCP endpoints is a
roadmap item.

## Tool router

Above `AGENT_TOOL_LIMIT` (default `40`) MCP tools, the agent
switches to **routed mode**. Instead of exposing every MCP tool to
the model, it exposes three meta-tools plus the render tools:

| Meta-tool                                  | Purpose                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `list_resources()`                         | Enumerate the backend's resources (one per schema), with each resource's tool list. |
| `use_resource({ name })`                   | Switch focus to a resource. Subsequent `call_mcp_tool` calls are gated to its tools. |
| `call_mcp_tool({ name, args })`            | Invoke a specific MCP tool. `name` must belong to the active resource.    |

This pattern is the same "load detail only when selected" idea the
[skill index](/agents/personas-memory-skills/#skills--slot-3)
applies to knowledge, now applied to tool schemas. For backends
with ~30 schemas (≈150+ tools) it's the difference between *"the
model picks the right tool 95% of the time"* and *"the model gets
lost in the menu."*

### How the model uses it

```text
1. list_resources()
   → { resources: [ { name: 'product', tool_count: 8, tools: [...] }, ... ] }
2. use_resource({ name: 'product' })
   → { resource: 'product', allowed_tools: [ 'list_product', 'get_product', ... ] }
3. call_mcp_tool({ name: 'list_product', args: { filter: { status: 'published' } } })
   → { results: [ ... ], page: 1, total: 42 }
```

The router state lives **per-turn** — `state.activeResource` resets
when the next user message arrives — so a turn that needs two
resources calls `use_resource` twice. The model is reminded of this
in each tool's description.

### Tuning the threshold

Set `AGENT_TOOL_LIMIT=0` to force routing on every backend
(useful when smaller LLMs get confused by many tools). Set it very
high to never route. The default (`40`) is conservative — most
models can juggle ~50 tools, but tool-call accuracy degrades fast
above that.

### Why not split tools into multiple routers?

A prior design tried to swap the AI SDK's `tools` argument
mid-loop. It doesn't work: `streamText` captures the tools object
once per call, so the model would see an empty MCP tool list
(because `activeResource` starts null) and never get the real CRUD
tools even after picking one. The meta-tool pattern is what
actually works.

## Render tools

Two synthetic tools the model can call to ask for a structured
visualization. They are **not** part of davepi's MCP surface —
they're injected by the agent so the model has a channel-neutral
way to say *"show this as a table"* or *"show this as a chart."*
The channel adapter decides how to draw it.

### `render_table`

```ts
render_table({
  title?: string,
  columns: Array<string | { key: string, label?: string }>,
  rows: Array<Record<string, any>>      // max 500
})
```

| Channel    | Output                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------- |
| HTTP / SSE | Forwarded as a `render` event with `payload.type === 'table'`. Your client picks a renderer. |
| Slack      | Block Kit `section` with a markdown table. Wide tables (>10 columns) fall back to a fenced code block. |
| Custom     | You implement it in the channel adapter.                                                  |

### `render_chart`

```ts
render_chart({
  title?: string,
  vegaLiteSpec: object,                 // Vega-Lite v5 spec
})
```

| Channel    | Output                                                                                |
| ---------- | ------------------------------------------------------------------------------------- |
| HTTP / SSE | Forwarded as a `render` event with `payload.type === 'chart'`.                        |
| Slack      | [QuickChart](https://quickchart.io) image URL embedded as a Block Kit `image` block.   |
| Custom     | You implement it in the channel adapter.                                              |

### Safety

Both tools take **strictly-typed Zod payloads** (`columns`, `rows`,
`vegaLiteSpec`). The model never gets to emit raw HTML or SVG, so a
prompt-injected response can't smuggle markup into a channel. The
500-row cap on tables is a defence against the model dumping a
runaway listing.

### Steering the model toward them

The render tools' descriptions are explicit about when to use them:

> *"Use this whenever you have row-shaped data the user should see
> (lists, search results, summaries). Do NOT hand-write a markdown
> table in your text response when this tool is available — the
> channel adapter will render it more cleanly than markdown can."*

Combined with the operating-contract block of the system prompt
(*"Prefer the render_table / render_chart tools to present data
instead of dumping raw JSON in your reply"*), Anthropic and OpenAI
models reliably reach for the right tool. Smaller / local Ollama
models sometimes hand-roll a markdown table anyway — if that
matters, narrow the model with `LLM_SYSTEM_PROMPT`.

### Opting out

```bash
AGENT_INCLUDE_RENDER=false
```

Removes both tools from the model's surface. Replies become
text-only. Useful when you're embedding the agent somewhere that
can't paint richer output (a terminal client, a voice channel).

## Prompt caching (Anthropic only)

Anthropic's API supports **prompt caching**: tell it a portion of
the prompt is stable across calls, and subsequent calls re-use the
cached prefix at a discount. The agent uses this aggressively:

- The [frozen snapshot](/agents/personas-memory-skills/#the-prompt-slot-model)
  (persona + operating contract + skill index + memory + profile) is
  byte-stable for the whole session.
- The agent places a cache breakpoint after the snapshot, so every
  turn within the session re-uses it.
- Tool descriptions also live ahead of the breakpoint — so adding
  rows to memory or a skill mid-session doesn't bust the cache, but
  starting a new session (or a hot-reload that changes the tool
  list) does.

The orchestrator emits a `cache` event per turn:

```json
{
  "type": "cache",
  "cacheReadInputTokens": 14823,
  "cacheCreationInputTokens": 0
}
```

`cacheReadInputTokens` should be non-zero for every turn after the
first in a session. If it's always zero, the cache isn't hitting —
common causes:

- Provider isn't Anthropic.
- `LLM_PROMPT_CACHING=false` (you turned it off).
- The frozen snapshot is being re-assembled every turn (likely a
  config bug — check `AGENT_SESSION_IDLE_SECONDS`).
- The conversation row isn't being persisted (`AGENT_PERSIST_CONVERSATIONS=false`
  or service mode without a stable conversation key).

[→ Troubleshooting: cache miss](/agents/troubleshooting/#anthropic-cache-isnt-hitting)

## Max steps

```bash
LLM_MAX_STEPS=8     # default
```

One "step" is one round of model output + (possibly) one tool call.
The agent loops up to this many times before giving up. Increase
for runbooks that chain many tool calls (a multi-step refund
flow); decrease to fail fast in cheap inner loops.

## Putting it together

A typical turn against a backend with ~12 schemas (so router off):

```
1. Model receives system prompt (persona + skills + memory + profile + contract)
2. Model sees ~80 MCP tools + 2 render tools.
3. User: "Plot weekly orders for the last month as a bar chart."
4. Model calls list_order({ filter: { date: { __gte: '...' } }, perPage: 200 }).
5. Tool result: orders[] with date+amount+...
6. Model calls render_chart({ vegaLiteSpec: { mark: 'bar', encoding: { x: 'week', y: 'sum_amount' } } }).
7. The HTTP channel emits a `render` event; the browser draws the chart.
8. Model emits a final paragraph summarising the trend.
```

Same turn, on a backend with 40+ schemas (router on):

```
1. Model sees ~5 tools: list_resources, use_resource, call_mcp_tool, render_table, render_chart.
2. Model calls list_resources(), sees `order` among the resources.
3. Model calls use_resource({ name: 'order' }).
4. Model calls call_mcp_tool({ name: 'list_order', args: { ... } }).
5. … (same as before from step 5)
```

The router adds two tool calls; the model never gets confused by a
150-tool menu.
