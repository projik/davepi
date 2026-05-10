---
title: Schema-driven generation
description: How one schema file becomes REST, GraphQL, MCP, Swagger, an admin UI, and a typed client.
---

dAvePi's central idea: **the schema file is the source of truth, and
everything else is a projection.** Drop a file under
`schema/versions/v1/`, and the framework generates:

- **Mongoose model** — registered with the connection, indexes built
- **REST routes** — `POST`, `GET` (list), `PUT` (bulk), `GET / PUT / DELETE /:id`,
  `restore`, `history`, `aggregations`, file upload routes
- **GraphQL types** — output type, input types (writable / partial /
  filter), every standard resolver via `graphql-compose-mongoose`
- **MCP tools** — one per CRUD operation per schema, plus per-aggregation
  and per-relation tools
- **Swagger fragment** — paths and definitions wired into the live spec
- **Admin SPA resource** — Refine reads the `_describe` manifest at
  startup and renders forms / tables / detail views automatically
- **Typed client output** — `davepi gen-client` walks the schema map
  and emits per-resource interfaces and method signatures

```js
// schema/versions/v1/account.js
module.exports = {
  path: 'account',
  collection: 'account',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name',   type: String, required: true, searchable: true },
  ],
};
```

That's all you write. The list above happens at boot.

## Where the generation lives

`utils/schemaLoader.js` walks `schema/versions/*` once at startup. For
each schema it:

1. **Builds a Mongoose schema** with timestamps, soft-delete tombstone,
   composite indexes, full-text index for searchable fields.
2. **Composes a Mongoose-derived TC** in graphql-compose's registry,
   wraps every standard resolver with `wrapFilter` / `wrapByIdMutation`
   / etc. so tenant scoping is non-bypassable.
3. **Mounts a per-schema Express Router** carrying every REST route.
4. **Emits a Swagger fragment** into the live `apiSpec` object served
   by `/api-docs/swagger.json`.
5. **Registers MCP tools** via `utils/mcpServer.js` against the same
   registry.

Per-schema routers are mounted on the parent app via `app.use(router)`,
so a schema unload (during hot-reload) splices its router out without
rebuilding the whole stack.

## Hot reload

In dev (`HOT_RELOAD_SCHEMAS=true`), a chokidar watcher fires schema
add / change / unlink events. Each event runs through a single-flight
queue (`opChain` in the loader), so concurrent file changes don't
interleave registry mutations with `rebuildGraphQL`. The Apollo router
swap uses an indirection middleware: the parent app holds a `let
apolloRouter`, the loader replaces it on rebuild, in-flight requests
hit the previous router, new requests hit the new one.

See [Hot reload](/concepts/hot-reload/) for the full mechanism.

## Why one source of truth matters

Every surface stays in lockstep automatically. Add a field:

- The REST `POST` body schema knows about it.
- The GraphQL `input` type accepts it.
- The MCP `create_<path>` tool's input schema validates it.
- The Swagger UI shows it.
- The admin SPA renders a form input for it.
- The next `gen-client` run emits a TS field for it.

No backend / frontend drift. No "I forgot to update the GraphQL schema
when I added the field." No mismatch between the OpenAPI spec and what
the server actually accepts.

## What you give up

- **Schema-flexibility tax**: every resource looks the same shape
  (CRUD + tenancy + soft-delete). For a wildly bespoke surface, you'd
  add custom routes after the schema loop in `app.js`.
- **MongoDB only**: the framework is built on Mongoose; SQL backends
  aren't supported.
- **One ownership column**: `userId` is the tenant column on every
  schema. Multi-org / multi-team models layer on top via
  `accountId` or custom relations — see [Tenant isolation](/concepts/tenancy/).
