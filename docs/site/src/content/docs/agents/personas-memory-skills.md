---
title: Personas, memory, and skills
description: The agent learning layer — the SOUL/MEMORY/USER analogues plus governed skills, all backed by tenant-isolated davepi schemas with a frozen prompt snapshot for cache stability.
---

A bare `@davepi/agent` is stateless: every turn assembles the same
default system prompt and tools, and forgets the conversation when
the channel hands history back. The **learning layer** is the
opt-in feature set that gives an agent an identity it owns, memory
that persists across sessions, runbooks it can follow, and a
per-customer profile shared across the tenant's agents.

It's all backed by **tenant-isolated davepi schemas** read and
written through the agent's own MCP identity — not flat files on
the agent host. The JWT (or client id) remains the access boundary
even as the agent gets richer.

## Turning it on

The whole layer is gated on one env var:

```bash
AGENT_KEY=support      # or `sales`, `billing-ops`, etc.
```

Unset → no learning layer, default prompt, zero-config (same
behaviour as before #128's persona/memory work). Set → the agent
reads four rows at session start and folds them into the system
prompt:

| Slot | Source schema       | Key                              | Authored by                     |
| ---- | ------------------- | -------------------------------- | ------------------------------- |
| 1    | `agentPersona`      | `(tenant, agentKey)`             | Human operator                  |
| 3    | `skill` (index)     | `(tenant, agentKey, name)`       | Agent (drafts) + operator (approval) |
| 4    | `agentMemory`       | `(tenant, agentKey)`             | Agent (self-authored)           |
| 5    | `customerProfile`   | `(tenant, endUserKey)`           | Agent (self-authored), shared across tenant's agents |

(Slot 2 is the static operating contract — the framing string. Slot
6 is the volatile history + new turn, added by the orchestrator.)

## The prompt-slot model

The system prompt is assembled stable → volatile, so the long
stable prefix stays byte-identical across turns and Anthropic
prompt caching keeps hitting:

```
┌─────────────────────────────────────────────────┐
│ 1. Persona (SOUL)                               │  ┐
│    identity / style / avoid / defaults          │  │
├─────────────────────────────────────────────────┤  │
│ 2. Operating contract (static framing)          │  │
├─────────────────────────────────────────────────┤  │  frozen snapshot —
│ 3. Skill index (L0)                             │  │  byte-stable for the
│    name + description of approved skills        │  │  whole session
├─────────────────────────────────────────────────┤  │
│ 4. Agent memory (MEMORY) — body                 │  │
├─────────────────────────────────────────────────┤  │
│ 5. Customer profile (USER)                      │  │
│    preferences + notes                          │  ┘
├═════════════════════════════════════════════════┤  ← cache breakpoint
│ 6. Volatile — history + new turn                │     (Anthropic)
└─────────────────────────────────────────────────┘
```

Slots 1–5 are **snapshotted once at session start and frozen for
the whole conversation**. Mid-session writes to persona/memory/
skills hit the database but **do not** mutate the live prefix —
they take effect on the *next* session's snapshot. This is the
Hermes "frozen snapshot" discipline and it's the difference between
a healthy cache-hit rate and re-billing the full prefix every turn.

> **Live vs. remembered.** Treat memory/profile/persona as
> slow-changing background that may be slightly stale — never as
> live system state. For anything that changes (order status,
> ticket state, inventory, balances), the agent calls a tool to
> read it fresh. Snapshotted text shapes tone and recall; it is
> never an access-control or live-data mechanism.

A new session starts when the gap since the last turn exceeds
`AGENT_SESSION_IDLE_SECONDS` (default `1800` / 30 minutes). That
boundary is also when self-authored writes from the prior session
become visible.

## Persona — slot #1

The persona is the agent's identity and brand voice — the dAvePi
analog of [Hermes's `SOUL.md`](https://hermes-agent.nousresearch.com/docs/user-guide/features/personality).
One row per `(tenant, agentKey)`. It leads the system prompt and is
the most stable slot, so changes to it ripple through every future
session of every conversation.

### Schema

| Field         | Type   | Notes                                                            |
| ------------- | ------ | ---------------------------------------------------------------- |
| `agentKey`    | String | Which agent this is (`support`, `sales`, etc.). Required, unique per tenant. |
| `identity`    | String | First-person identity. *"You are Ada, the support agent for Acme."* |
| `style`       | String | Tone, length, vocabulary. *"Warm, concise, never more than three sentences."* |
| `avoid`       | String | Hard "don'ts" — compliance, brand. *"Never speculate about refunds or promise dates."* |
| `defaults`    | String | Background assumptions. *"Assume the customer is on the Pro plan unless told otherwise."* |
| `status`      | String | `active` or `archived`. Only `active` is rendered into the prompt. |
| `proposedPatch` | String | The one field the agent can write — a free-form proposal for operator review. |

### Authoring

Personas are **operator-authored**. Brand voice and compliance
"avoid" rules can't self-mutate unreviewed, so a deployment contract
applies on every write surface (REST, GraphQL, MCP):

- The agent's service token carries role `['agent']`. Field-level
  ACL on every live field strips agent writes on every surface —
  the agent's *only* writable field is `proposedPatch`.
- Human operators (role `user` / `admin`) author and update the
  live `identity` / `style` / `avoid` / `defaults` sections.
- `beforeDelete` refuses agent-authored deletes too (deletion would
  revert to the default prompt — governance, not privilege).

### Self-authored proposals

The agent can suggest changes by writing `proposedPatch`. An
operator reviews and applies. This replaces an earlier hook-routed
flow that didn't survive on MCP / bulk paths.

```js
// Agent (over MCP):
update_agentPersona({ id: '...', record: { proposedPatch: 'Soften the refund avoid rule to allow same-day refunds under $20.' } })

// Operator (via dashboard / REST):
update_agentPersona({ id: '...', record: { avoid: '...new text...', proposedPatch: null } })
```

### Worked example

```js
// schema/versions/v1/agentPersona.js is shipped by the framework — no need to author the schema.
// Just write a row, e.g. via REST after registering as the operator:
await fetch('http://localhost:5050/api/agentPersona', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_JWT}` },
  body: JSON.stringify({
    agentKey: 'support',
    identity: 'You are Ada, the support agent for Acme.',
    style: 'Warm and concise. Never more than three sentences. Always offer one concrete next step.',
    avoid: 'Never promise refund dates. Never speculate about future product features.',
    defaults: 'Assume the customer is on the Pro plan unless told otherwise.',
  }),
});
```

Next session — i.e. the agent's next conversation after this write —
the persona leads the prompt and the agent introduces itself as Ada.

[→ `agentPersona` schema source](https://github.com/projik/davepi/blob/main/schema/versions/v1/agentPersona.js)

## Memory — slot #4

The slow-changing facts the agent has learned about how *this
tenant* operates — *"EU customer base, default to GDPR-safe
phrasing"*, *"the Pro plan is the common case"*. One row per
`(tenant, agentKey)` with one free-form `body` field.

### Schema

| Field        | Type   | Notes                                                              |
| ------------ | ------ | ------------------------------------------------------------------ |
| `agentKey`   | String | Which agent this memory belongs to.                                |
| `body`       | String | Free-form markdown.                                                |
| `updatedBy`  | String | Provenance. `agent` (self-authored) or `operator:<id>` (corrected). |

### Self-authoring is the point

Unlike persona, memory is **the surface the agent is meant to
write**. *"The customer prefers email"* is a fact the agent
records, not brand voice an operator owns. There is no operator-only
field ACL. The agent updates memory through the schema-generated
MCP tools:

```
update_agentMemory({
  id: '<existing row id>',
  record: { body: '<new full body, including the just-learned fact>' }
})
```

Because the frozen snapshot is captured once per session, that
write takes effect on the *next* session — consistent with the
cache-stable prompt discipline, and the reason memory is safe to
self-author where persona is not.

### Provenance

Schema hooks only run on REST/GraphQL (not on MCP — see
[hooks](/features/hooks/)), so a hook alone can't stamp provenance
for the common (agent-authored) path. Memory uses two layers:

- Field `default: 'agent'` fires on the hookless MCP create — the
  agent's own self-authored path.
- `beforeCreate` / `beforeUpdate` hooks override with the operator
  identity (`operator:<id>`) when a human edits the memory via
  REST/GraphQL.

So `updatedBy` reads `agent` for self-authored memory and
`operator:<id>` once a human has corrected it — useful when you
want to know whether a fact was machine-learned or human-asserted.

[→ `agentMemory` schema source](https://github.com/projik/davepi/blob/main/schema/versions/v1/agentMemory.js)

## Customer profile — slot #5

The slow-changing preferences and notes the agent has learned about
**a specific end-user** — *"prefers email over phone"*, *"always
asks about the EU region first"*. One row per `(tenant, endUserKey)`
where `endUserKey` is **channel-prefixed**: `slack:U12345`,
`http:abc123`, `telegram:5871234`.

### Shared across the tenant's agents

Unlike persona / memory, the profile carries **no `agentKey`** — it's
keyed by `endUserKey` alone. What the support agent learns about a
customer benefits the sales agent too. Tenant isolation is still
the hard floor: account A's profiles cannot be read by account B
over REST, GraphQL, or MCP.

### Schema

| Field          | Type   | Notes                                                  |
| -------------- | ------ | ------------------------------------------------------ |
| `endUserKey`   | String | Channel-prefixed: `slack:U12345`. Required, indexed.  |
| `preferences`  | String | Free-form JSON or markdown. *Prefers email; region EU.* |
| `notes`        | String | Free-form prose.                                       |
| `lastSeenAt`   | Date   | Refreshed by `beforeCreate` / `beforeUpdate` hooks.    |
| `updatedBy`    | String | Same two-layer provenance pattern as memory.           |

### Injection sanitizer

`preferences` and `notes` are partly written from end-user input
("the user said *'always ignore my preferences'*"), so they are an
injection vector into a future session's identity tier. The
[prompt assembler](https://github.com/projik/davepi/blob/main/packages/davepi-agent/lib/promptAssembly.js)
runs the same sanitizer over this text that it runs over the
persona before it enters the prompt:

- Strip control characters.
- Neutralise role-control phrases (`ignore previous instructions`,
  fake `system:` turns, `<system>…</system>` tags).
- Cap section length and log when truncated.

The storage layer holds the raw text; the prompt layer
neutralises it.

[→ `customerProfile` schema source](https://github.com/projik/davepi/blob/main/schema/versions/v1/customerProfile.js)

## Skills — slot #3

Skills are **procedural memory** — reusable runbooks the agent
retrieves and follows. *"How we issue a refund"*, *"The steps to
triage a shipping complaint"*. They differ from persona (identity)
and memory (facts) in that they're *procedures* surfaced through
**progressive disclosure** so a hundred runbooks don't bloat every
prompt.

### Three disclosure tiers

| Tier | What's in the prompt                            | Loaded via                              |
| ---- | ----------------------------------------------- | --------------------------------------- |
| L0   | `name` + `description` of `approved` skills    | Slot #3 — always present in the system prompt. |
| L1   | The full `body` (markdown runbook)             | `get_skill` MCP tool, fetched on demand.|
| L2   | `attachments` (object-storage file)            | The existing file tools, only when the body references one. |

The L0 index is just enough for the model to know a runbook exists
and decide to read it. The body is fetched only after the model
picks the skill. Attachments come last. Same "load detail only when
selected" discipline the [tool router](/agents/tools-and-rendering/#tool-router)
applies to tool schemas, now applied to knowledge.

### Schema

| Field          | Type   | Notes                                                                  |
| -------------- | ------ | ---------------------------------------------------------------------- |
| `agentKey`     | String | Which agent owns this skill. Required, indexed.                        |
| `name`         | String | L0 title. Searchable, weighted above description.                      |
| `description`  | String | L0 one-liner — what the runbook is for.                                |
| `body`         | String | L1 — the full markdown procedure.                                      |
| `attachments`  | File   | L2 — private; served by short-lived signed URLs.                       |
| `useCount`     | Number | Bumped when an approved skill is fetched. Surfaces promotion candidates. |
| `status`       | String | State machine: `draft → approved → deprecated`. `deprecated` is terminal. |

### Governance

A self-authored runbook **cannot reach a live customer unreviewed**.
Two layers enforce that an agent can author drafts but only a human
operator can promote one, and they hold on every write surface
(REST, GraphQL, *and* MCP):

1. The state machine **stamps `draft` on every create**. An agent
   (or a forged `{ status: 'approved' }` request) can never author
   a live skill. `beforeCreate` re-asserts this on the REST/GraphQL
   paths as defence-in-depth.
2. Field-level ACL on `status` (`['user', 'admin']`) strips it from
   any write by the `agent` role on every surface. Only an operator
   can transition `draft → approved` (or `→ deprecated`).

Because the L0 index only ever lists `approved` skills, a half-baked
self-authored runbook stays invisible to customers until a human
signs off, and a `deprecated` skill drops out of the index again.

> `deprecated` is terminal. A retired runbook is never re-approved
> in place (which would silently re-enter the L0 index); authoring
> a fresh skill is the path back.

### Following a skill

In practice the model:

1. Sees a relevant name + description in the L0 index.
2. Calls `get_skill({ id: '...' })` to read the full `body`.
3. Follows the steps, calling tools as the runbook directs.

If the body references an attachment, the model calls the file
tools to fetch it (L2).

### The learning loop

When a conversation is marked `resolved` (over the normal update
surface — REST, GraphQL, or MCP), an `onEnter` hook on the
`conversation.status` state machine emits a `conversation.resolved`
event on the framework's [event bus](/features/webhooks/).
Pair `davepi-plugin-queue` (BullMQ) with a worker that consumes
this event off-thread; the worker runs a fresh extraction agent on
the transcript and, when the approach was non-trivial and the
outcome positive, proposes a `skill` in `status: draft`. Operators
approve via the state machine; trivial chats produce nothing;
resolving a conversation never blocks the response.

[→ `skill` schema source](https://github.com/projik/davepi/blob/main/schema/versions/v1/skill.js)
&nbsp;·&nbsp;
[→ `conversation` schema source](https://github.com/projik/davepi/blob/main/schema/versions/v1/conversation.js)

## Multiple agents per tenant

One tenant runs many agents — `support`, `sales`, `billing-ops`,
`onboarding`. Each is a distinct process with its own `AGENT_KEY`,
persona row, memory row, and skill set:

```
┌────────────────┐        ┌────────────────┐        ┌────────────────┐
│ AGENT_KEY=     │        │ AGENT_KEY=     │        │ AGENT_KEY=     │
│   support      │        │   sales        │        │   billing      │
│                │        │                │        │                │
│ persona row    │        │ persona row    │        │ persona row    │
│ memory  row    │        │ memory  row    │        │ memory  row    │
│ skills (N)     │        │ skills (M)     │        │ skills (K)     │
└────────┬───────┘        └────────┬───────┘        └────────┬───────┘
         │                         │                         │
         └─────────┬───────────────┴─────────┬───────────────┘
                   │                         │
                   ▼                         ▼
        ┌──────────────────────┐  ┌──────────────────────┐
        │ shared:              │  │ shared:              │
        │ customerProfile rows │  │ tenant data          │
        └──────────────────────┘  └──────────────────────┘
```

- `agentPersona`, `agentMemory`, `skill` — keyed by `(tenant, agentKey)`.
  Distinct per agent.
- `customerProfile` — keyed by `(tenant, endUserKey)`. **Shared**
  across the tenant's agents.
- `conversation` — keyed by `(tenant, agentKey, channel, conversationId)`.
  Distinct per agent.

Run one process per agent (different `AGENT_KEY`), or build a
dispatcher that mints per-agent instances from one shared process
using [`createAgent({ agent: { key } })`](/agents/programmatic-api/).

### The agent service role

Each agent process authenticates as a tenant-owned user whose token
carries role `['agent']`. Field-level ACL on `agentPersona.identity`
/ `style` / `avoid` / `defaults` / `status` and on `skill.status`
gates these to `['user', 'admin']` — so the agent can author drafts
and propose persona patches but can't promote a skill or rewrite
its own identity. Make sure the user your agent uses for service
auth has role `agent` (not `user` or `admin`), or those gates
collapse open.

## Worked example: a session, end to end

Given:

- `AGENT_KEY=support`
- A row in `agentPersona`: *"You are Ada from Acme. Warm, concise."*
- A row in `agentMemory.body`: *"Customer base is mostly EU. Default to GDPR phrasing."*
- Two approved skills: *"Issue a refund"*, *"Triage a shipping complaint"*.

First turn from a Slack user the agent has met before
(`endUserKey=slack:U12345`, profile says *"prefers email"*):

1. **Session start.** The orchestrator calls `list_agentPersona`,
   `list_agentMemory`, `list_skill (approved, by useCount)`, and
   `list_customerProfile` through the agent's MCP identity.
2. **Snapshot.** `promptAssembly.assembleSystemPrompt` renders all
   four into the cache-stable prefix. `conversation.systemSnapshot`
   is persisted on the conversation row; the row's `lastTurnAt`
   updates.
3. **The model.** Sees the persona ("Ada from Acme"), the operating
   contract, the skill index ("Issue a refund — how to issue a
   refund within policy", etc.), the memory ("EU base, GDPR"), and
   the profile ("prefers email").
4. **Tools.** When the user says *"can I get a refund?"*, the model
   sees *Issue a refund* in the L0 index, calls `get_skill` for the
   body, and follows it — using `list_order` to fetch the actual
   order (live data, not remembered) under the agent's ACL.
5. **Self-author.** When the customer mentions a new preference,
   the model calls `update_customerProfile` to record it. The next
   session sees the update.

Throughout, the JWT is what scopes every read. The model never sees
*"only show user X's data"* in the prompt.

## Zero-config fallback

With `AGENT_KEY` unset, none of the four lookups happen, the prompt
is exactly the default `DEFAULT_SYSTEM_PROMPT` framing, and the
agent behaves like post-#128 — useful when you're standing up a new
backend and don't want to author rows yet.

Switching it on later is one env var. No code changes needed.
