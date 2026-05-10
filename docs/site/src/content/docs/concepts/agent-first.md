---
title: Why agents come first
description: dAvePi was designed assuming AI coding agents (Claude Code, Cursor, Aider, Continue) build apps on it.
---

Most backends were designed assuming humans write the schemas and
the integration glue. dAvePi was designed assuming an **AI coding
agent** does both. The choices that follow are different from the
ones a human-first framework would make.

## What agent-first means in practice

### 1. Discovery before code

`GET /_describe` returns a compact JSON manifest of every loaded
schema — fields, relations, aggregations, file fields, ACL slots,
soft-delete / audit / search flags, REST endpoints, GraphQL queries
and mutations, MCP tools.

An agent landing on a fresh dAvePi can plan against the API in one
round-trip, before writing a line of integration code. Compare with
`swagger.json`: 5–10× larger, Swagger 2.0 conventions, no first-class
representation of relations or state machines.

[→ \_describe reference](/surfaces/describe/)

### 2. Native tool calls

Agents don't write HTTP requests; they call tools. dAvePi's MCP
server exposes per-resource tools (`list_account`, `create_deal`,
`transition_status_quote`, etc.) that agents call as first-class
operations.

```json
{
  "name": "create_deal",
  "arguments": {
    "record": { "title": "Q1", "amount": 50000 },
    "idempotencyKey": "9f3c-..."
  }
}
```

The same handlers REST and GraphQL use back the tool calls — no
divergence, no maintenance tax. Both transports (HTTP + stdio) are
shipped.

[→ MCP server reference](/surfaces/mcp/)

### 3. Idempotent retries

Agents retry. Network blip, model timeout, harness restart. Without
idempotency, retries silently create duplicate records — one of the
most common agent failure modes in production.

dAvePi accepts an `Idempotency-Key` header on every `POST`, plus an
`idempotencyKey` argument on every `create_<path>` MCP tool. Same
key + same body = original response replayed. Different body under
the same key = `409 IDEMPOTENCY_CONFLICT`. Atomic claim-execute-
complete protocol guards against duplicate creates under concurrent
retries.

[→ Idempotency keys](/features/idempotency/)

### 4. Stable contracts the agent can rely on

Every typed error the framework returns carries a structured
payload: `{ code, message, details? }`. `INVALID_TRANSITION` ships
the current / attempted / allowed states; `IDEMPOTENCY_CONFLICT`
ships the conflicting body's hash; `VALIDATION` ships the recoverable
flag. Agents read the code, not the human-readable message, and
decide whether to retry.

[→ Error reference](/reference/errors/)

### 5. Type safety end-to-end

`davepi gen-client` walks the schema map and emits a fully-typed TS
client. The same schema file that drives the server drives the
agent's frontend code at compile time. A typo in a field name is a
red squiggle, not a runtime 500.

[→ TypeScript client](/surfaces/client/)

### 6. A drop-in `agent.md`

Every scaffolded project ships an `agent.md` file (mirrored to
`.cursorrules` for Cursor users) that tells the agent the conventions
of the framework: don't manually wire `userId`, don't use `accountId`
as a custom FK, prefer computed over client-side derivation, use
`__include` rather than N+1 calls. Agents that follow it produce
working code on the first try.

## What this isn't

dAvePi is not "AI-generated code that you then maintain." The
framework is hand-written; the *output* of any single agent
interaction is a schema file and the auto-generated surface flowing
from it. There's no LLM call at runtime. There's no
"AI-generated SQL" surface. The agent is a tool that uses dAvePi;
dAvePi doesn't use the agent.

## What about humans?

Humans write the same schemas. The agent surfaces (MCP, `_describe`,
the typed client) are equally useful when you're writing code by
hand — they're not "for agents only." But the framework's API design
optimises for the case where an agent is the primary author. Where
the human-friendly choice and the agent-friendly choice diverged,
we picked the agent-friendly one.
