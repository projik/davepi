# davepi-plugin-skill-extractor

The **learning loop** for [`@davepi/agent`][agent] — the last workstream
of the Hermes-style learning layer ([RFC §7][rfc]). Good outcomes become
draft skills automatically: when a conversation is resolved, a **fresh**
extraction agent reads the transcript and, *only* when the approach was
non-trivial and the outcome positive, proposes a reusable runbook. The
runbook lands as a `draft` skill scoped to the originating account; a
human approves it (the [#131][skills] state machine) before it can ever
reach a live customer.

```
conversation resolved ──► conversation.resolved (record bus)
        │
        ▼
  this plugin ──► davepi-plugin-queue (off-thread) ──► fresh extraction agent
                                                              │
                                          non-trivial + positive?
                                                              │ yes
                                                              ▼
                                                   draft skill (account-scoped)
```

[agent]:  https://docs.davepi.dev/surfaces/agent/
[rfc]:    https://github.com/projik/davepi/blob/main/docs/agent-learning-layer.md
[skills]: https://github.com/projik/davepi/issues/131

## Why off-thread

Extraction runs an LLM over the whole transcript — slow, and pure
upside if it never happens (a missed extraction just means no draft
skill, never a failed request). So it's **best-effort and asynchronous**:
resolving a conversation emits an event and returns immediately; the
queue worker does the extraction later. Resolving a conversation never
blocks the response.

The queue **job carries only identifiers + tenancy** (`userId`,
`accountId`, `agentKey`, `recordId`) — never the transcript itself. The
conversation `history` is the full JSON transcript, re-serialized every
turn, so it grows without bound; copying it into every Redis job would
bloat the queue. The worker re-reads `history` from the (already
persisted) conversation record by id instead. If the record is gone by
the time the job runs (deleted between resolution and extraction), the
worker logs and skips — best-effort, as everywhere else.

## Requirements

- The **`skill` schema** (#131) and the **`conversation` schema** with
  its `status` state machine must be present in the backend.
- **[davepi-plugin-queue][queue]** must be installed and **enabled**
  (`QUEUE_REDIS_URL` set). If the queue is dormant, this plugin logs a
  warning at boot and stays dormant too — events are simply not acted
  on, never an error.
- An LLM. By default the extraction agent uses the AI SDK + Anthropic
  (`ANTHROPIC_API_KEY`); inject your own `runExtraction` to use a
  different stack.

[queue]: https://www.npmjs.com/package/davepi-plugin-queue

## Install

```bash
npm install davepi-plugin-skill-extractor davepi-plugin-queue
```

List both plugins in your project's `package.json`, **queue first**:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-queue", "davepi-plugin-skill-extractor"]
  }
}
```

## How resolution works

A conversation is closed by transitioning its `status` field — the same
governed, davepi-native path on REST, GraphQL, and MCP:

```
open ──► resolved     # reached a good outcome → triggers extraction
open ──► abandoned    # petered out / dropped  → no extraction
```

The agent (or an operator) sets `status: 'resolved'` via the normal
update tool. There's no field ACL on `status`, so the agent's service
role can close its own conversations. Arriving at `resolved` emits the
`conversation.resolved` event this plugin consumes.

## Configuration

The default export is configured for the common case. For tests or a
non-Anthropic LLM, build an instance with `createPlugin`:

```js
const { createPlugin } = require('davepi-plugin-skill-extractor');

module.exports = createPlugin({
  // ({ system, transcript, messages, agentKey }) => Promise<string>
  runExtraction: myLlmCall,
  minMessages: 4,          // skip transcripts shorter than this
  modelId: 'claude-sonnet-4-5',
});
```

| Option          | Default                                  | Notes                                             |
| --------------- | ---------------------------------------- | ------------------------------------------------- |
| `queue`         | `require('davepi-plugin-queue')`         | The queue instance to enqueue on / register with. |
| `runExtraction` | fresh Anthropic call (`lib/agent.js`)    | The LLM call. Inject to swap providers / in tests.|
| `getSkillModel` | looks up `skill` off `schemaLoader`      | Override the model source.                        |
| `getConversationModel` | looks up `conversation` off `schemaLoader` | Source for re-reading the transcript by id. |
| `jobName`       | `skill.extract`                          | Queue job name.                                   |
| `minMessages`   | `4`                                      | Pre-filter: shorter chats never spend an LLM call.|
| `modelId`       | `SKILL_EXTRACT_MODEL` or `claude-sonnet-4-5` | Model for the default agent.                  |

## The extraction verdict

The fresh agent (no tools, no data access — it only reads the
transcript) replies with strict JSON:

```json
{ "skill": null }
```

for the common, trivial case, or:

```json
{
  "skill": {
    "name": "Reset a locked account",
    "description": "Steps to safely unlock an account after repeated failed logins.",
    "body": "1. Verify identity...\n2. ..."
  }
}
```

The plugin validates the shape, then persists it as a `draft` skill with
`userId`/`accountId` stamped from the originating conversation. Skill
names are unique per `(account, agentKey)`, so re-resolving a
conversation (or a similar one) never duplicates or overwrites an
existing skill — including one an operator has already approved.

## Governance

The worker writes the skill directly via the model, so it forces
`status: 'draft'` itself (matching `stampInitialStates`). The draft is
**invisible to the L0 prompt index** until an operator promotes it
`draft → approved`. An extracted runbook can never reach a customer
unreviewed — the safeguard Hermes's auto-reuse lacks on a
customer-facing surface.
