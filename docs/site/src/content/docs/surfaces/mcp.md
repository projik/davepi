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

## Wiring to Claude Desktop

Add an MCP server entry to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or the Windows equivalent:

```json
{
  "mcpServers": {
    "davepi": {
      "command": "node",
      "args": ["/absolute/path/to/davepi/bin/davepi.js", "mcp"],
      "env": {
        "MONGO_URI": "mongodb://localhost:27017/davepi",
        "TOKEN_KEY": "your-token-key",
        "DAVEPI_TOKEN": "<long-lived-jwt>",
        "NODE_ENV": "development"
      }
    }
  }
}
```

Claude Desktop spawns this process on startup, the stdio transport
carries JSON-RPC messages, and every dAvePi tool appears in the
model's tool list.

## Wiring to Claude Code

Drop a `.mcp.json` file at your project root:

```json
{
  "mcpServers": {
    "davepi": {
      "command": "node",
      "args": ["./node_modules/.bin/davepi", "mcp"],
      "env": {
        "MONGO_URI": "mongodb://localhost:27017/davepi",
        "TOKEN_KEY": "your-token-key",
        "DAVEPI_TOKEN": "<long-lived-jwt>"
      }
    }
  }
}
```

Or, if you'd rather hit the running HTTP server, use the `mcp` HTTP
transport pointed at `http://localhost:5050/mcp` with a Bearer
token.

The `npx create-davepi-app` scaffolder drops a working `.mcp.json`
in every generated project — the easiest path to a working setup
is to scaffold a template and open it in Claude Code.

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

## Worked example

Once wired, an agent can plan against the API directly:

> "Create an account named 'Acme', then add a contact 'Jane' tied to it, then list contacts."

Behind the scenes, the model calls:

1. `create_account({ record: { accountName: "Acme" } })` → `{ _id: "abc" }`
2. `create_contact({ record: { name: "Jane", accountId: "abc" } })` → `{ _id: "xyz" }`
3. `list_contact({ filter: { accountId: "abc" } })` → `{ results: [...], totalResults: 1 }`

— all under the JWT user's tenant scope, with ACL projection and
soft-delete filtering applied automatically.

## See also

- [Why agents come first](/concepts/agent-first/) — the design rationale.
- [\_describe manifest](/surfaces/describe/) — what an agent reads on first contact.
- [Idempotency keys](/features/idempotency/) — `idempotencyKey` argument on every `create_<path>` tool.
