---
title: Hot reload
description: Schema files reload without restarting the server, including the GraphQL schema and the MCP tool list.
---

In dev (`HOT_RELOAD_SCHEMAS=true`), saving a file under
`schema/versions/v1/` reloads its surface live — REST routes,
GraphQL types, Swagger fragments, MCP tools all update without a
restart. Existing requests in flight finish against their old
surface; new requests hit the new one.

## What gets reloaded

| On save / change | What rebuilds |
|------------------|---------------|
| Add a new schema file | New Mongoose model, new REST router, new GraphQL TC and resolvers, new Swagger fragment, new MCP tools (on stdio: clients see `tools/list_changed`). |
| Edit an existing schema | Mongoose model is `deleteModel`'d and re-registered, REST router replaced, GraphQL TC rebuilt, Swagger updated, MCP tools refreshed. |
| Delete a schema file | Router spliced from the Express stack, model deleted, GraphQL TC removed, Swagger fragment unset, MCP tools unregistered. |

## How it works

`utils/schemaLoader.js` exposes a single-flight queue (`opChain`).
The chokidar watcher in `utils/schemaWatcher.js` produces add /
change / unlink events; each call enqueues a `loadSchema` /
`unloadSchema` operation. They run sequentially, so a fast burst of
filesystem events can't interleave registry mutations with
`rebuildGraphQL`.

### GraphQL: indirection middleware

Apollo Server v3 builds its schema at construction time — there's no
"swap the schema" API. The framework solves this with a stable
indirection layer:

```js
// app.js mounts ONCE at boot:
let apolloRouter = null;
app.use((req, res, next) => {
  if (apolloRouter) return apolloRouter(req, res, next);
  return next();
});

// On every schema reload, the loader does:
//   1. Build a new ApolloServer + apply its middleware to a fresh
//      express.Router.
//   2. Atomically swap the `apolloRouter` reference.
//   3. Stop the old ApolloServer (release plugins / sockets).
```

Order matters: build → swap → stop. Stopping first would leave the
indirection pointing at a dead router during the rebuild window.

### REST: per-schema routers

Each schema's REST routes live on their own `express.Router`.
`unloadSchema` splices the router out of `app._router.stack` by
reference — Express has no public "remove route" API, so this is the
cleanest way to clear a schema's surface without rebuilding the
whole stack.

After every load / unload, the framework re-appends the central
`errorHandler` so it stays at the tail of the stack (Express only
routes errors to a final tail handler).

### MCP: live tool registry

The stdio MCP server (long-lived) subscribes to `schemaLoader.onChange`
and rebuilds its tool list on every change. Each rebuild calls
`server.sendToolListChanged()` so connected clients (Claude Desktop /
Cursor / Code) refresh their tool registry without reconnecting.

The HTTP MCP transport at `/mcp` builds a fresh server per request, so
hot-reload is automatic — no special wiring needed.

## Performance

Hot reload runs entirely in-process; no fork, no restart. A typical
single-schema reload completes in 50–150ms on modest hardware (Mongo
index creation is the long pole). The single-flight queue means a
burst of saves coalesces — the watcher only fires `rebuildGraphQL`
when the whole batch has settled.

## Production posture

Hot reload is gated on `NODE_ENV !== 'production' && HOT_RELOAD_SCHEMAS=true`.
In production, schemas load once at boot. Use [migrations](/operations/migrations/)
for schema changes that need to be applied to running instances.

## Tests

`test/hot-reload.test.js` covers:

- Programmatic load / unload (no file events) and asserts that
  routes / Swagger / GraphQL fields appear and disappear.
- Reload-the-same-schema is idempotent (no duplicate routes mounted).
- Edits to an existing schema with new fields round-trip on POST / GET.
- Watcher is gated by both `HOT_RELOAD_SCHEMAS` and `NODE_ENV`.
