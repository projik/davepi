---
title: Agents — overview
description: A guide to creating and running davepi agents — what they are, the ACL boundary that makes them safe, the learning layer that makes them durable, and where to start.
---

A **davepi agent** is a chat process that talks to your dAvePi
backend through its [MCP server](/surfaces/mcp/). It ships as the
[`@davepi/agent`](https://github.com/projik/davepi/tree/main/packages/davepi-agent)
package — pre-wired for HTTP `/chat`, Slack, OpenAI / Anthropic /
Ollama providers, two auth modes, and a learning layer (persona,
memory, skills, profiles) backed by tenant-isolated davepi schemas.

```
┌──────────────┐     SSE / Slack / DM      ┌──────────────┐    MCP / HTTP    ┌──────────────┐
│  end-user    │  ─────────────────────▶   │  davepi      │  ──────────────▶ │  davepi      │
│  (or widget) │                           │  agent       │                  │  backend     │
└──────────────┘                           │  (this pkg)  │                  │  (your app)  │
                                           └──────┬───────┘                  └──────┬───────┘
                                                  │                                 │
                                                  │  Anthropic / OpenAI / Ollama    │  MongoDB
                                                  ▼                                 ▼
```

The agent is the **interactive** counterpart to
[`@davepi/mcp`](https://github.com/projik/davepi/tree/main/packages/mcp).
Where `@davepi/mcp` is a stdio↔HTTP bridge so a developer tool
(Claude Desktop, Cursor) can act as a privileged operator against
your backend, `@davepi/agent` is a process you run to host an
end-user-facing chatbot.

## The one design rule

The JWT (or `X-Client-Id`) **is** the access boundary. The agent
never re-implements ACL checks and never constrains results via
prompt text. If you want a public storefront bot to only see
"published" products, declare a [`schema.acl.scope[role]`](/features/acl/)
filter on the davepi side; the MCP server applies it on every read
and the agent never sees the filter.

The wrong pattern, and the one to avoid, is a broad service token
plus *"only show user X's data"* in the prompt — that's a
confused-deputy bug waiting to happen.

> Persona, memory, skills, and customer-profile snapshots shape
> behaviour and tone. They are **never** an access-control mechanism.
> Live, sensitive data is always reached by a tool call under the
> caller's identity.

## What you get

| Capability             | Out of the box                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| Channels               | HTTP `/chat` (SSE), Slack (`@`-mention + DM). Telegram / WhatsApp / widget templates. |
| LLM providers          | Anthropic (default), OpenAI, Ollama (local, no key)                            |
| Tool surface           | Every schema's CRUD + relations + aggregations + audit + file ops auto-derived from the MCP server. |
| Tool router            | Above `AGENT_TOOL_LIMIT` (40) the model picks a resource first, then loads its tools. |
| Render tools           | `render_table` and `render_chart` — channel-neutral structured output.         |
| Auth                   | Service-account (one JWT or client id) OR per-user (OAuth-style link flow).    |
| Learning layer         | Per-agent persona, slow-changing memory, per-end-user profile, governed skills (runbooks). |
| Conversation history   | Persisted to davepi's `conversation` schema, with a frozen prompt snapshot for cache stability. |
| Proactive jobs         | Pair with `davepi-plugin-cron` to fire approved skills on a schedule.          |
| Programmatic API       | `createAgent` / `runTurn` / `mcpClient` for embedding in your own process.     |

## Two mental models

### Service-account agent

One identity for the whole bot — right for anonymous storefronts
(client id paired with `schema.acl.scope[role]` filters) and
internal "shared inbox" bots. Easiest to deploy: one bearer token,
no per-user linking, no refresh-token store.

[→ Auth modes](/agents/auth/)

### Per-user agent

Each channel user maps to a real davepi user via a one-time link
flow (email + password form served by the agent itself). The agent
stores refresh tokens locally and mints access tokens on demand.
Right for customer-portal bots where each user must see only their
own data, enforced by davepi's normal owner-scoping.

## Where to start

| If you want to…                                       | Read                                       |
| ----------------------------------------------------- | ------------------------------------------ |
| Boot an agent against a local davepi in 10 minutes    | [Getting started](/agents/getting-started/)|
| Look up an environment variable or config field       | [Configuration reference](/agents/configuration/) |
| Give your agent a voice and durable memory            | [Personas, memory, and skills](/agents/personas-memory-skills/) |
| Wire Slack, or build a custom channel adapter         | [Channels](/agents/channels/)              |
| Decide between service and per-user auth              | [Auth modes](/agents/auth/)                |
| Understand tool routing or the render tools           | [Tools and rendering](/agents/tools-and-rendering/) |
| Schedule SLA digests, follow-ups, or daily summaries  | [Proactive agents](/agents/proactive-agents/) |
| Embed the agent in your own Node process              | [Programmatic API](/agents/programmatic-api/) |
| Diagnose a stuck link flow or a 401                   | [Troubleshooting](/agents/troubleshooting/)|

## How this section relates to the rest of the docs

- [Surfaces → Agent](/surfaces/agent/) is the *reference* page — env
  vars, install command, one-line examples. This section is the
  *guide* — task-shaped, with worked examples.
- [Tutorials](/tutorials/) build an end-to-end app (schema + admin +
  agent + Slack). They include agent steps but the agent is one
  component. Read those after you've shipped your first agent here.
- [Concepts → Why agents come first](/concepts/agent-first/) is the
  framework-level argument for why dAvePi is built this way. This
  section assumes you already buy that argument and want to ship.

## A note on multiple agents per tenant

One tenant can run many agents — `support`, `sales`, `billing-ops`,
`onboarding`. Each one is a distinct process with its own
`AGENT_KEY`, persona row, memory row, and skill set; they share the
tenant's `customerProfile` rows (what support learned about a
customer benefits sales too). [Personas, memory, and skills](/agents/personas-memory-skills/)
walks through the multi-agent identity model end to end.
