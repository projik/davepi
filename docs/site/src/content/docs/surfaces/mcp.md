---
title: MCP server
description: dAvePi exposes its full schema-driven surface as an MCP server — REST/GraphQL/MCP from one schema, with Claude Desktop and Claude Code wiring.
---

dAvePi exposes its full schema-driven surface as a [Model Context
Protocol](https://modelcontextprotocol.io/) server, so AI agents
(Claude Desktop, Claude Code, Cursor, etc.) can call into the API
as native tools — no hand-written integration glue required.

The MCP server is generated **from the same schema registry** that
powers REST and GraphQL. Add a schema, and `list_<resource>`,
`get_<resource>`, `create_<resource>`, `update_<resource>`,
`delete_<resource>`, plus per-aggregation tools, appear
automatically.

## Two transports

| Transport | Use it when | Endpoint |
|-----------|-------------|----------|
| Streamable HTTP | The agent / IDE talks to a running dAvePi server. Stateless. | `POST /mcp` |
| stdio | Claude Desktop / Code spawn the binary as a child process. | `davepi mcp` |

Both transports share the same tool implementations from
`utils/mcpServer.js`. Tenant isolation, ACL projection, and
soft-delete behaviour all match the REST surface exactly — the MCP
tools delegate to the same Mongoose models and helpers
(`runAggregation`, `applyIncludes`, etc.).

## Auth

Both transports authenticate the same way: a JWT issued by `/login`.
The token's `user_id` claim becomes the tenant identity for every
tool call.

- **HTTP**: `Authorization: Bearer <token>` on every `POST /mcp` request.
- **stdio**: `DAVEPI_TOKEN` env var, set when launching the process.

The CLI verifies the token at startup using `TOKEN_KEY` (the same
secret that signs `/login` responses) and refuses to start with an
invalid or missing token.

## Tools generated per schema

| Tool | When | Description |
|------|------|-------------|
| `list_<path>` | always | Paginated list, with optional `filter` (mongo-style), `sort`, `q` (full-text), `include` (relations), and `includeDeleted`. |
| `get_<path>` | always | Fetch one record by `_id`. Accepts the same `include` set as the list tool. |
| `create_<path>` | always | Create a record. `userId` / `accountId` stamped from the JWT — never accepted from the caller. |
| `update_<path>` | always | Partial update by `_id`. Field-level ACL filters non-writable fields out of the payload; `userId`/`accountId` are stripped from the wire so a caller can't reassign ownership. |
| `delete_<path>` | always | Soft-delete (or hard-delete on schemas with `softDelete: false`). |
| `restore_<path>` | `softDelete` enabled (default) | Clear the `deletedAt` tombstone so the record becomes readable again. |
| `history_<path>` | `audit` enabled (default) | Returns the audit log for a record — `create` / `update` / `delete` / `restore` actions, newest first. Field-level read-ACL applied to before/after/diff. |
| `search_<path>` | any field has `searchable: true` | Full-text search across the framework-owned text index. Equivalent to `list_<path>` with `sort=score:desc`. |
| `list_<path>_<rel>` | per `hasMany` relation | Returns the relation's children for a parent `_id` in a single batched query. |
| `get_<path>_<rel>` | per `hasOne` / `belongsTo` relation | Returns the populated relation (or null) for a parent `_id`. |
| `upload_<path>_<field>` | per `type: 'File'` field | Upload a base64-encoded blob. Validates against the field's `maxBytes` and `accept`. |
| `fetch_<path>_<field>` | per `type: 'File'` field | Returns the public or short-lived signed URL plus the file metadata. |
| `delete_<path>_<field>` | per `type: 'File'` field | Removes the blob and clears the metadata sub-doc. |
| `aggregate_<path>_<name>` | per declared aggregation | Params surface with their declared types; the framework prepends `$match: { userId }` automatically. |
| _(state-machine transitions)_ | per state-machine field | Use `update_<path>` with `{ id, record: { <field>: <to> } }`. The framework validates against `transitions[current]` and rejects undeclared moves with `INVALID_TRANSITION`. |

Every tool result is JSON: a record (or list response) on success,
or — on a typed failure — an MCP `isError: true` result with a
structured payload:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "{ \"error\": { \"code\": \"VALIDATION\", \"message\": \"...\", \"recoverable\": true } }" }]
}
```

The error payload carries:

- `code` — `VALIDATION`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `DUPLICATE`, `INVALID_ID`, etc.
- `message` — human-readable description.
- `recoverable: true` on errors an agent can fix by adjusting its arguments (`VALIDATION`, `INVALID_ID`). Distinguishes "fix the call and retry" from "this won't ever work."
- `auth: true` on `UNAUTHORIZED` so clients can dispatch credential refresh / re-prompting without parsing free-text codes.

Unknown errors propagate and the SDK wraps them as internal — same
posture as the REST `Internal server error` reduction in production.

## Wiring an agent: `@davepi/mcp`

The published `@davepi/mcp` package collapses agent wiring to a
single `npx -y` line. It runs in either of the two modes above
depending on environment:

- `DAVEPI_URL` set → HTTP-proxy mode, talks to the remote `/mcp`
  endpoint.
- `DAVEPI_URL` unset → local-stdio mode, spawns `davepi mcp` from
  the project's local install.

### Claude Code (`.mcp.json` at project root)

```json
{
  "mcpServers": {
    "davepi": {
      "command": "npx",
      "args": ["-y", "@davepi/mcp"],
      "env": {
        "DAVEPI_URL": "http://localhost:5050",
        "DAVEPI_TOKEN": "<long-lived-jwt>"
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

macOS path: `~/Library/Application Support/Claude/claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "davepi": {
      "command": "npx",
      "args": ["-y", "@davepi/mcp"],
      "env": {
        "DAVEPI_URL": "https://api.example.com",
        "DAVEPI_TOKEN": "<long-lived-jwt>"
      }
    }
  }
}
```

### Cursor

Same config shape under `.cursor/mcp.json` or Cursor's MCP settings.

The `npx create-davepi-app` scaffolder drops a working `.mcp.json`
pre-wired with `@davepi/mcp` in every generated project — the
easiest path to a working setup is to scaffold a template and open
it in Claude Code.

## Issuing a long-lived token for stdio

```bash
node -e '
  const jwt = require("jsonwebtoken");
  console.log(jwt.sign(
    { user_id: "<your-user-id>", roles: ["user"] },
    process.env.TOKEN_KEY,
    { expiresIn: "30d" }
  ));
'
```

Treat that token like any other API credential — it grants the full
tool surface as that user.

## Hot-reload

Both transports respond to schema changes live:

- **HTTP**: each `POST /mcp` builds a fresh server from the current registry.
- **stdio**: subscribes to `schemaLoader.onChange` and rebuilds the tool list on the existing connection. The SDK emits a `notifications/tools/list_changed` notification so the connected client (Claude Desktop, etc.) refreshes its tool registry without reconnecting.

See [Hot reload](/concepts/hot-reload/) for the underlying mechanism.

## Worked examples (CRM template)

The examples below assume a project scaffolded from the CRM starter
(`npx create-davepi-app my-crm --template crm`). That template ships
four resources — `account`, `contact`, `deal`, `activity` — plus two
aggregations on `deal` (`pipelineByStage`, `wonByMonth`) and a
state-machine `stage` field on `deal`. The scaffolder drops a working
`.mcp.json` at the project root, so opening the directory in Claude
Code lights up the full tool surface listed above.

These transcripts elide the agent's natural-language reasoning and
show only the tool calls the model issues — that's the part you can
reproduce verbatim against any CRM-template install.

### 1. Onboard a new account end-to-end

> "Add Acme Inc as a new account (manufacturing, ~250 employees), put
> Jane Doe down as the primary contact at jane@acme.com, and open a
> $50k Q1 expansion deal against it."

```jsonc
// 1. Create the account
create_account({
  record: { name: "Acme Inc", industry: "manufacturing", employees: 250 }
})
// → { _id: "acc_01H...", name: "Acme Inc", ... }

// 2. Primary contact, joined via parentAccountId
create_contact({
  record: {
    parentAccountId: "acc_01H...",
    firstName: "Jane",
    lastName:  "Doe",
    email:     "jane@acme.com",
    isPrimary: true
  }
})
// → { _id: "con_01H...", fullName: "Jane Doe", ... }

// 3. Deal — stage stamped "lead" by the state machine's initial state
create_deal({
  record: {
    parentAccountId: "acc_01H...",
    title:  "Q1 expansion",
    amount: 50000
  }
})
// → { _id: "dl_01H...", stage: "lead", availableTransitions: ["qualified", "lost"], ... }
```

Note the `availableTransitions` array on the deal response — the
state machine surfaces the legal next moves on every read, so the
agent doesn't have to memorise the diagram in `deal.js`.

### 2. Move a deal through the pipeline

> "Acme's Q1 deal had a good demo. Move it to proposal and log a
> meeting note against it."

```jsonc
// 1. Find the deal by name
search_deal({ q: "Q1 expansion" })
// → { results: [{ _id: "dl_01H...", stage: "lead", ... }], totalResults: 1 }

// 2. State-machine transition: lead → qualified
update_deal({ id: "dl_01H...", record: { stage: "qualified" } })

// 3. Then qualified → proposal
update_deal({ id: "dl_01H...", record: { stage: "proposal" } })

// 4. Log the activity
create_activity({
  record: {
    type:    "meeting",
    subject: "Acme demo — Q1 expansion",
    body:    "Walked through pricing. Send proposal Friday.",
    dealId:  "dl_01H..."
  }
})
```

If the agent skips a step and tries `lead → won`, the tool returns
`isError: true` with `code: "INVALID_TRANSITION"` and
`recoverable: true` — the model can read `availableTransitions` from
a fresh `get_deal` and retry along a legal path.

### 3. Build a weekly status answer with one aggregation call

> "Show me the current pipeline by stage, and how much we closed-won
> in the last three months."

```jsonc
aggregate_deal_pipelineByStage({})
// → [
//     { _id: "proposal",    total: 320000, count: 4 },
//     { _id: "qualified",   total: 175000, count: 6 },
//     { _id: "negotiation", total: 110000, count: 2 },
//     ...
//   ]

aggregate_deal_wonByMonth({})
// → [
//     { _id: { year: 2026, month: 3 }, total: 180000, count: 3 },
//     { _id: { year: 2026, month: 4 }, total: 240000, count: 5 },
//     { _id: { year: 2026, month: 5 }, total:  90000, count: 1 }
//   ]
```

The framework prepends `$match: { userId }` to both pipelines, so the
numbers are scoped to the JWT holder automatically — the agent never
has to thread a tenant filter through.

### 4. Pull a full account view with relations populated

> "Give me everything we know about Acme — contacts, open deals, and
> the last few activities."

```jsonc
get_account({ id: "acc_01H...", include: ["contacts", "deals", "primaryContact"] })
// → {
//     _id: "acc_01H...", name: "Acme Inc",
//     primaryContact: { _id: "con_01H...", fullName: "Jane Doe", ... },
//     contacts: [ ... ],
//     deals:    [ { _id: "dl_01H...", title: "Q1 expansion", stage: "proposal", ... } ]
//   }

list_activity({
  filter: { dealId: "dl_01H..." },
  sort:   "-occurredAt",
  limit:  5
})
```

One `get_account` call returns the joined object graph because the
CRM schemas declare `contacts: hasMany`, `deals: hasMany`, and
`primaryContact: hasOne` — the relation tool surface matches the
shape an agent would naturally ask for.

### 5. Audit who changed what

> "Who moved the Acme deal to negotiation, and when?"

```jsonc
history_deal({ id: "dl_01H..." })
// → [
//     { action: "update", at: "2026-05-22T14:08:11Z", by: "usr_...",
//       diff: { stage: { from: "proposal", to: "negotiation" } } },
//     { action: "update", at: "2026-05-19T09:21:02Z", by: "usr_...",
//       diff: { stage: { from: "qualified", to: "proposal" } } },
//     { action: "create", at: "2026-05-12T17:44:00Z", by: "usr_...", ... }
//   ]
```

`history_<path>` is available on every schema with `audit` enabled
(the default), and field-level read-ACL is applied to the
before/after payloads — a `viewer` role won't see diffs of fields
they can't read live.

### 6. Soft-delete and recover

> "I accidentally deleted that meeting note — bring it back."

```jsonc
list_activity({ q: "Acme demo", includeDeleted: true })
// → { results: [{ _id: "act_01H...", deletedAt: "2026-05-23T...", ... }], ... }

restore_activity({ id: "act_01H..." })
// → { _id: "act_01H...", deletedAt: null, ... }
```

`delete_activity` is a soft-delete by default; `restore_activity` is
generated automatically and clears the tombstone.

All six transcripts run under the JWT user's tenant scope, with ACL
projection and soft-delete filtering applied by the same code that
backs the REST and GraphQL surfaces — the agent never sees another
tenant's rows, and never needs to learn a second authorization model.

## See also

- [Why agents come first](/concepts/agent-first/) — the design rationale.
- [\_describe manifest](/surfaces/describe/) — what an agent reads on first contact.
- [Idempotency keys](/features/idempotency/) — `idempotencyKey` argument on every `create_<path>` tool.
