---
title: Proactive (scheduled) agents
description: Pair @davepi/agent with davepi-plugin-cron to run a fresh agent on a schedule that follows a named approved skill and posts to Slack — follow-ups, SLA digests, end-of-day summaries.
---

Agents don't have to wait to be spoken to. Pair `@davepi/agent`
with [`davepi-plugin-cron`](https://github.com/projik/davepi/tree/main/packages/davepi-plugin-cron)
to run a **fresh** agent on a schedule that follows a named,
**approved** [skill](/agents/personas-memory-skills/#skills--slot-3)
and posts its output to Slack — follow-ups, SLA digests,
end-of-day summaries.

The pattern carries over from Hermes ("cron job = fresh instance,
attached skill") but the skill is a **governed, tenant-scoped
record** rather than a JSON file in `~/.hermes/cron`. Approval is a
state transition; tenant isolation is the same hard floor as every
other read.

## What happens on each tick

1. The cron lease fires the handler for one tenant agent.
2. The handler loads the named skill through the agent's own MCP
   identity, filtered to `status: 'approved'` — a draft or
   deprecated runbook is **never** fired.
3. The handler runs a fresh `runTurn` (empty history, no end-user)
   with the persona loaded and the skill's `body` inlined as the
   task. Live data is fetched with tools, not assumed from the
   snapshot.
4. The reply (plus any `render_table` / `render_chart` output) is
   posted to Slack.

## Wiring it up

```js
const { createAgent } = require('@davepi/agent');
const cron = require('davepi-plugin-cron');

const agent = await createAgent({ agent: { key: 'support' } });

cron.register('daily-sla-digest', {
  schedule: '0 9 * * 1-5',          // 9am on weekdays
  handler: agent.scheduledSkill({
    skill: 'Daily SLA digest',       // name of an approved skill for this agentKey
    slackChannel: 'C0123456789',     // Slack channel id to post into
    // prompt: 'optional override of the default autonomous preamble',
    // threadTs: 'optional thread to post into',
  }),
});
```

`agent.scheduledSkill(...)` is a thin shortcut around
`createScheduledHandler({ agent, ... })`. Both return an async
function with the cron handler signature
`({ log, signal, now, name }) => result` that you hand to
`cron.register(name, { schedule, handler })`.

### Required options

| Option         | Required | Notes                                                                |
| -------------- | -------- | -------------------------------------------------------------------- |
| `agent`        | yes      | The result of `createAgent()` — `{ config, model, mcpClient, auth }`. |
| `skill`        | yes      | The `name` of an `approved` skill row for this `agentKey`.            |
| `slackChannel` | yes      | Slack channel id (e.g. `C0123…`) to post into. Bot must be a member. |
| `prompt`       | no       | Override the default autonomous trigger preamble (see below).         |
| `threadTs`     | no       | Slack `thread_ts` to post into a specific thread instead of a channel. |
| `channelCtx`   | no       | Override the default `cron` context — see [Multi-tenant cron](#multi-tenant). |

### The trigger preamble

By default the handler prepends this autonomous-trigger preamble to
the skill body before handing it to the model:

> *You are running as a scheduled job. No human is in this
> conversation, so there will be no follow-up — gather what you
> need with your tools and produce the complete output the runbook
> below calls for in a single reply. Use the render tools for
> tables/charts where the runbook asks for them.*

Override with `prompt` if you want a different framing. The skill
body is appended after the preamble verbatim, so the runbook
remains the operator-approved source of truth.

## The Slack poster

The handler reuses the same Block Kit rendering as interactive
Slack replies, so a scheduled digest looks like any other agent
reply — markdown text, then any `render_table` / `render_chart`
blocks from the run.

`SLACK_BOT_TOKEN` must be set on the agent's config (the poster
uses the bundled `@slack/web-api` client). The full Slack channel
doesn't have to be enabled — `SLACK_ENABLED=false` is fine, as long
as `SLACK_BOT_TOKEN` is configured. The bot needs `chat:write` on
the target channel.

A run that produces no output (no text and no render blocks) **skips
the post** rather than posting a blank message. That gives the
runbook a clean "nothing to report" branch — *"if no breaches
today, return an empty response"* — without an empty Slack ping.

## Governance carries over for free

Because only `approved` skills are loadable in `runScheduledSkill`,
a half-baked self-authored runbook can never be fired by a cron
job until a human signs off (see
[Skills → Governance](/agents/personas-memory-skills/#governance)).
The state machine plus field-level ACL on `skill.status` is the
gate; the cron handler just respects it.

To **disable** a runbook without deleting the skill row, an
operator transitions `approved → deprecated`. The next tick can't
find it and throws `SKILL_NOT_FOUND`; the cron framework surfaces
the error in its lease logs.

## Cancellation (lost leases)

`davepi-plugin-cron` distributes scheduled jobs across multiple
nodes via a **lease** — one node holds the lease per tick. If the
lease is lost mid-run (network partition, GC pause, another node
takes over), the cron framework's `AbortSignal` is threaded through
the handler:

```
cron lease.signal
   │
   ▼
createScheduledHandler  ─►  runScheduledSkill  ─►  runTurn
                                                     │
                                                     ├──►  MCP tool calls (signal forwarded via fetch)
                                                     └──►  model.streamText (abortSignal)
```

Cooperative cancellation, not preemptive:

- The handler checks `signal.aborted` at three boundaries: before
  loading the skill, before running the turn, before posting to Slack.
- The MCP client passes the signal into the HTTP transport, so
  an in-flight tool call is cancelled.
- The model stream gets `abortSignal`, so generation stops at the
  next token boundary.
- If the lease is lost during the turn, the handler returns
  `{ posted: false, aborted: true }` and **nothing is posted** — so
  the node that takes over the lease can do the post without a
  double-message.

The agent should never keep writing after another node has taken
over.

## Multi-tenant {#multi-tenant}

Tenant scoping is **inherited, not re-implemented**. The agent's
service auth owns exactly one tenant's data, so the skill lookup
and the run are tenant-scoped server-side just like every other
read. For a multi-tenant deployment, register one job per tenant:

```js
for (const tenant of tenants) {
  const tenantAgent = await createAgent({
    auth: { bearer: tenant.agentJwt },        // tenant-specific JWT
    agent: { key: 'support' },
  });
  cron.register(`sla-${tenant.id}`, {
    schedule: '0 9 * * 1-5',
    handler: tenantAgent.scheduledSkill({
      skill: 'Daily SLA digest',
      slackChannel: tenant.slackChannel,
    }),
  });
}
```

Each tenant's `agentPersona`, `agentMemory`, and approved skills
are read under that tenant's identity. Per-tenant Slack channels
keep digests visible to the right operators.

## Per-user auth + cron

Service auth is the **default and the expectation** for proactive
agents. A scheduled run has no end-user, so the default `cron`
context has no `channelUserId`. Per-user auth resolves the agent's
identity *from* the end-user — so a per-user agent is **rejected at
registration** unless you pass an explicit `channelCtx` with a
`channelUserId`:

```js
// Advanced: a job that acts as one specific linked user.
agent.scheduledSkill({
  skill: 'Weekly portfolio summary',
  slackChannel: 'C0123…',
  channelCtx: { channel: 'cron', channelUserId: 'user-42' },
});
```

The handler fails fast on registration (not on the first tick),
matching `davepi-plugin-cron`'s posture of surfacing
misconfiguration up front.

## Direct API (no Slack)

If you don't want the Slack poster — you'd rather post to a
different surface, write to a row, or just log — use
`runScheduledSkill` directly:

```js
const { runScheduledSkill } = require('@davepi/agent');

const { text, history, skill, renderBlocks } = await runScheduledSkill({
  config: agent.config,
  model: agent.model,
  mcpClient: agent.mcpClient,
  skill: 'Daily SLA digest',
  // optional:
  prompt: 'Custom preamble…',
  channelCtx: { channel: 'cron', agentKey: 'support' },
  signal: someAbortSignal,
  onEvent: (evt) => log.debug(evt),
});

// Do whatever you want with text + renderBlocks.
```

Throws an error with `code: 'SKILL_NOT_FOUND'` if no approved skill
matches. Returns `{ aborted: true, skill?, renderBlocks? }` on
signal abort.

## Worked example: the SLA digest

Imagine a `support` agent with:

- An approved skill `Daily SLA digest`:

  > *Read all open tickets where `responseDueAt < now`. For each
  > breach, list owner / ticket id / hours overdue. If nothing is
  > overdue, return an empty response. Otherwise post a
  > `render_table` with columns Owner, Ticket, Hours overdue.*

- A persona that frames the agent as *"Ada, Acme Support — concise
  and operational."*

The cron handler ticks at 9am on weekdays:

1. `loadSkillByName` returns the skill row through the agent's MCP
   identity (tenant-scoped server-side).
2. `runScheduledSkill` runs a fresh `runTurn` with the persona
   loaded and the skill body inlined. No `channelUserId`, so no
   customer profile slot — just persona + skills + memory.
3. The model calls `list_supportTicket({ filter: { responseDueAt: { __lt: 'now' }, status: 'open' } })`.
4. Three breaches today. The model calls `render_table` with the
   right columns.
5. The handler posts the markdown + table to `#support-ops` on
   Slack. Ops sees an Ada-shaped reply at 9:01.

If there were no breaches, the model produces an empty response,
and the handler logs *"scheduled skill produced no output; nothing
posted"* and returns `{ posted: false, empty: true }`.

## See also

- [`davepi-plugin-cron`](https://github.com/projik/davepi/tree/main/packages/davepi-plugin-cron)
  — the scheduler this composes with.
- [Skills — slot #3](/agents/personas-memory-skills/#skills--slot-3)
  — how skills are authored, governed, and surfaced.
- [Programmatic API](/agents/programmatic-api/) — for embedding the
  scheduled-skill handler in a richer process.
