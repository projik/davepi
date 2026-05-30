# RFC: The "learning" layer for `@davepi/agent`

Status: **Draft for review** · Owner: dave@unlockedequity.com · Target branch: `claude/hermes-ai-agent-concepts-PT3rF`

## 0. Why this doc exists

PR #128 (`@davepi/agent`) shipped the **body** of a Hermes-style agent: one
orchestration core (`runTurn`), thin channel adapters (HTTP, Slack, plus
stubs), tools auto-derived from davepi's MCP server, a tool router for
large schemas, render tools, and service/per-user auth. What it does **not**
have is the part of Hermes that "gets more capable the longer it runs": a
persona it owns, memory that persists, skills it can author and reuse, and a
loop that turns good outcomes into reusable knowledge.

This RFC proposes that layer for a business running **multiple agents** (support,
sales, ops) across Slack and customer-service surfaces. It is written to be
sliced into tickets — each workstream below (§4–§8) is independently shippable
and maps to one ticket (or a small epic).

The Hermes concepts we're porting, and the davepi primitive each lands on:

| Hermes concept | davepi primitive it maps to |
| --- | --- |
| `SOUL.md` (persona/identity, prompt slot #1) | `agentPersona` schema, per tenant + agent |
| `MEMORY.md` (episodic facts) | `agentMemory` schema, tenant + agent scoped |
| `USER.md` (per-user preferences) | `customerProfile` schema, tenant + end-user scoped |
| Skills + progressive disclosure (L0/L1/L2) | `skill` schema + `File` fields + object-storage plugin |
| `skill_manage` / self-authoring | agent writes skill/memory **as MCP tool calls** (governed by hooks/ACL) |
| Frozen-snapshot system prompt (cache-stable) | `lib/promptAssembly.js` + Anthropic prompt caching |
| Learning loop (extract skill after success) | `record` event bus → queue plugin → extraction worker |
| Cron jobs with attached skills | `davepi-plugin-cron` + `skill` records |
| Injection scan + truncation of identity files | a sanitizer in prompt assembly |

## 1. The one design rule that makes this safe

Everything here is **stored server-side as tenant-isolated davepi records**, not
as flat files on the agent host. That is the single most important departure
from Hermes. Hermes keeps `SOUL.md`/`MEMORY.md`/skills as markdown in
`~/.hermes`; for a business running multiple agents over shared infrastructure
that has no tenant boundary, no ACL, no audit, and no concurrency story.

Because persona/memory/skills are davepi schemas:

- they inherit **`accountId` tenant isolation** for free (the hard invariant);
- the agent reads/writes them **through the same MCP + ACL surface** as every
  other resource — no new privileged path;
- **governance is a state machine**, not a code review of a markdown file;
- they're queryable, auditable, and versioned like any other record.

Corollary, restating #128's "design rule": the JWT / client-id remains the
access boundary. We never put "only show user X" in the prompt. Persona, memory
and skills shape *behavior and tone*; they must never be relied on for *access
control*. Live, sensitive data is always reached by a **tool call** under the
caller's identity, never by trusting snapshotted text.

## 2. Identity model: agent, tenant, end-user

Three scoping keys recur throughout:

- `accountId` — the **tenant** (the business). Already davepi's isolation key.
- `agentKey` — **which agent** within the tenant (e.g. `support`, `sales`,
  `billing-ops`). `channelCtx` in #128 already carries channel/agent context;
  we formalize `agentKey` as a first-class field.
- `channelUserId` / a resolved davepi `userId` — **which end-user** is talking
  (per-user auth already resolves this; service auth has none, so per-user
  memory simply doesn't apply there).

Persona and agent-memory are keyed by `(accountId, agentKey)`. Customer
profiles are keyed by `(accountId, endUserKey)` and are **shared across agents**
of the same tenant (the sales bot benefits from what support learned).

## 3. The prompt-slot model (where everything plugs in)

Hermes assembles the system prompt in tiers, stable → volatile, so the long
stable prefix stays byte-identical and the provider cache keeps hitting. We
replicate that in a new `packages/davepi-agent/lib/promptAssembly.js` that
`orchestrator.js` calls instead of using its hard-coded `DEFAULT_SYSTEM_PROMPT`.

Assembly order (top = most stable = cached prefix):

1. **Persona** (SOUL) — `agentPersona` for `(accountId, agentKey)`. Appears
   **once**, as identity. Slot #1, like Hermes.
2. **Operating contract** — the existing static framing ("tools enforce ACL,
   don't add for-user filters, prefer render tools…").
3. **Skill index (L0)** — `name + description` for `status: approved` skills of
   this agent. Just enough for the model to know what runbooks exist.
4. **Agent memory snapshot (MEMORY)** — `agentMemory` body for the agent.
5. **Customer profile snapshot (USER)** — `customerProfile` for this end-user
   (per-user mode only).
6. **Volatile** — conversation history + the new user turn (this is the
   only part that changes turn-to-turn).

> **Cache breakpoint goes after slot 5.** Slots 1–5 are snapshotted **once at
> session start** and held byte-stable for the whole conversation. Mid-session
> writes to persona/memory/skills hit the database but **do not** mutate the
> live prefix — they take effect on the *next* session's snapshot. This is the
> Hermes "frozen snapshot" discipline and it's the difference between a healthy
> cache-hit rate and re-billing the full prefix every turn. (Use the repo's
> `claude-api` skill when wiring the Anthropic provider so caching is on by
> default and the breakpoint sits in the right place.)

`promptAssembly.js` also runs a **sanitizer** over persona/memory/profile text
before it enters the prompt: strip/escape role-control phrases ("ignore previous
instructions", fake `system:` turns), cap each slot's length, and log when it
trips. Hermes does exactly this scan-and-truncate on `SOUL.md`; for us it
matters more because the customer profile is partly **written from end-user
input**, so it's an injection vector into a future session's identity tier.

## 4. Workstream A — Persona (SOUL.md analog)  ·  *ticket: "Agent persona schema + prompt slot #1"*

**Goal:** each agent has an owned, editable identity that leads the system prompt.

- New schema `schema/versions/v1/agentPersona.js`: fields `accountId`, `userId`
  (owner/operator), `agentKey` (unique per account), `identity`, `style`,
  `avoid`, `defaults` (the four Hermes sections), plus `status`
  (`active`/`archived`). Owner-only ACL by default; expose **read** to the
  agent's service role.
- `promptAssembly.js` renders these four sections as slot #1. If no persona row
  exists, fall back to today's `DEFAULT_SYSTEM_PROMPT` (zero-config still works).
- The agent may **propose** persona edits via a normal update tool, but a
  `beforeUpdate` hook routes agent-authored changes to a `proposedPatch` field
  for human approval rather than mutating the live persona (operators own brand
  voice and compliance "avoid" rules — these can't self-mutate unreviewed).
- **Why this is first:** it's pure schema + one assembly function, no
  dependencies, immediately useful (per-agent brand voice), and it establishes
  the prompt-assembly seam that B and C plug into.

Acceptance: two agents on one tenant answer in distinguishably different voices
driven only by their persona rows; persona text is sanitized; missing-persona
path is covered by a test.

## 5. Workstream B — Memory + conversation persistence + frozen snapshot  ·  *ticket: "Persistent memory & cache-stable prompt assembly"*

**Goal:** the agent stops forgetting, and the prompt prefix stays cacheable.

- New schemas: `agentMemory` (`accountId`, `agentKey`, `body`, `updatedBy`) and
  `customerProfile` (`accountId`, `endUserKey`, `preferences`, `notes`,
  `lastSeenAt`).
- **Conversation persistence:** today `runTurn` takes `history` and hands it
  back; nothing stores it. Add a `conversation` schema (or extend the store) so
  history survives across requests, keyed by `(accountId, agentKey, channel,
  channelUserId)`. Note: `store.js` currently holds **only auth tokens** — keep
  auth state where it is; conversation history is tenant data and belongs in
  davepi, not the local JSON file.
- **Frozen snapshot:** `promptAssembly.js` reads persona/memory/profile **once**
  at session start, caches the assembled prefix on the session, and reuses it
  for every turn. Provider call uses Anthropic prompt caching with the
  breakpoint after the snapshot.
- **Self-authored memory:** expose `agentMemory`/`customerProfile` updates as
  tools so the agent can record "customer prefers email over phone." A
  `beforeUpdate`/`beforeCreate` hook stamps provenance and the write takes
  effect next session (consistent with the frozen-snapshot rule).
- **Live vs remembered:** document the boundary — slow-changing preferences →
  memory; order status / ticket state → always a tool call.

Acceptance: a fact taught in session 1 shows up (via snapshot) in session 2;
cache-hit metrics show the prefix is reused within a session; mid-session memory
writes do **not** change the in-flight prefix (tested).

## 6. Workstream C — Skills schema + progressive disclosure  ·  *ticket: "Skills as governed records with L0/L1/L2 disclosure"*

**Goal:** procedural memory — reusable runbooks the agent retrieves and follows.

- New schema `schema/versions/v1/skill.js`: `accountId`, `userId`, `agentKey`,
  `name` (indexed), `description` (`searchable` — L0), `body` (markdown — L1),
  `attachments` (`File`/object-storage — L2), `useCount`, and a
  `stateMachine` on `status`: `draft → approved → deprecated`.
- **Disclosure tiers** reuse machinery #128 already has:
  - **L0** — `name + description` of `approved` skills injected by
    `promptAssembly.js` (prompt slot #3).
  - **L1** — a `skill.get`/`read_skill` tool returns `body` on demand.
  - **L2** — `attachments` fetched through the existing object-storage file
    tools only when referenced.
  This is the same "load detail only when selected" idea the tool router
  already applies to tool schemas — now applied to knowledge.
- **Governance via state machine + ACL:** the agent's service role can `create`
  skills but a `beforeCreate` hook forces `status: draft`; only an operator role
  can transition `draft → approved`. The L0 index only ever shows `approved`
  skills, so a half-baked self-authored runbook can't reach a live customer
  until a human signs off. This is the safeguard Hermes's auto-reuse lacks —
  critical on a customer-facing surface where a bad runbook becomes a wrong
  answer to *everyone*.

Acceptance: an approved skill's L0 appears in the prompt and the model fetches
L1 before following it; an agent-created skill lands as `draft` and is invisible
to the L0 index until approved; `deprecated` skills disappear.

## 7. Workstream D — The learning loop  ·  *ticket: "Skill extraction from successful conversations"* (depends on C)

**Goal:** good outcomes become draft skills automatically.

- On resolution, the agent (or the channel) emits a `conversation.resolved`
  `record` event on `utils/events.js`.
- `davepi-plugin-queue` (BullMQ) consumes it off the bus — **not inline**;
  extraction is slow and best-effort.
- The worker runs a **fresh** extraction agent (mirrors Hermes "cron job = fresh
  instance"; `eval/lib/agent.js` is a usable template) that reads the transcript
  and, only when the approach was non-trivial and the outcome positive, proposes
  a `skill` in `status: draft`.
- Humans approve via the §6 state machine. Optionally bump `useCount` when an
  approved skill is fetched, to surface candidates for promotion/retirement.

Acceptance: a non-trivial resolved conversation produces a coherent draft skill
without blocking the response; trivial chats produce none; the proposed skill is
tenant-scoped to the originating account.

## 8. Workstream E (optional, later) — Proactive / cron agents  ·  *ticket: "Scheduled agents with attached skills"*

**Goal:** agents that act without being prompted (follow-ups, SLA digests).

- Use `davepi-plugin-cron`: a scheduled job loads a named `skill` + persona and
  runs a fresh `runTurn`. Output posts to Slack via the existing channel.
- This is Hermes's cron-with-attached-skill model, but the skill is a governed,
  tenant-scoped record rather than a JSON file in `~/.hermes/cron`.

Defer until A–D are proven internally.

## 9. Sequencing & dependencies

```
A (persona)  ─┐
              ├─► establishes promptAssembly seam
B (memory)   ─┘
                     C (skills) ──► D (learning loop) ──► E (cron, optional)
```

- **A and B** can land in parallel; both need `promptAssembly.js`, so whoever
  goes first creates it and the other extends it.
- **C** depends on the assembly seam (for the L0 index) but not on B.
- **D** hard-depends on **C** (no skills schema → nothing to extract into).
- **E** depends on **C** (attached skills) and benefits from A/B.

Suggested order for tickets: **A → B → C → D → (E)**. A is the smallest, lowest
risk, and proves the seam; ship customer-facing surfaces only after C/D are
exercised internally (Slack first — lower stakes than the public widget).

## 10. Cross-cutting requirements (apply to every ticket)

- **CHANGELOG.md** entry per PR (repo rule; one dense paragraph under
  `## [Unreleased]`).
- **Tenant isolation tests** for every new schema — confirm one account can't
  read another's persona/memory/skills via REST, GraphQL, *and* MCP.
- **Injection-sanitizer tests** for persona/memory/profile → prompt.
- **Frozen-snapshot test** — mid-session writes don't alter the in-flight
  prefix.
- **Zero-config fallback** — with no persona/memory/skill rows, the agent
  behaves exactly like post-#128.

## 11. Open questions for review

1. **Conversation history home** — dedicated `conversation` schema (queryable,
   auditable, tenant-isolated; my recommendation) vs. extending the local
   `store.js`? The auth store is deliberately local; history is tenant data and
   probably shouldn't live there.
2. **`agentKey` source of truth** — env/config per deployed agent process, or a
   first-class `agent` registry schema so one deployment can host many agents?
3. **Self-authored persona** — allow agents to propose persona edits at all, or
   keep persona 100% human-authored and reserve self-authoring for
   memory + skills only?
4. **Customer-profile retention/PII** — TTL, redaction, and right-to-be-forgotten
   posture for `customerProfile`, especially on public surfaces.
5. **Approval UX** — where do operators review draft skills / proposed persona
   patches? A davepi admin route, a Slack approval message, or both?

## 12. Sources

- [Hermes Agent — Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- [Hermes Agent — Personality & SOUL.md](https://hermes-agent.nousresearch.com/docs/user-guide/features/personality)
- [Use SOUL.md with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-soul-with-hermes)
- [Hermes Agent Deep Dive (DEV)](https://dev.to/truongpx396/hermes-agent-deep-dive-build-your-own-guide-1pcc)
- [NousResearch/hermes-agent (DeepWiki)](https://deepwiki.com/NousResearch/hermes-agent)
