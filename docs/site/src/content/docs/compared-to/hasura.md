---
title: dAvePi vs. Hasura
description: GraphQL-first on Postgres (and other SQL backends), with introspection-driven schema and role-based row/column permissions. dAvePi takes the same "schema → API" idea but generates REST + GraphQL + MCP from a single file.
---

Hasura's pitch: point it at a SQL database, get a GraphQL API
auto-generated from the introspected schema, with role-based
row/column permissions managed in a console. Event triggers fire
on row changes; Actions wrap arbitrary HTTP endpoints into the
GraphQL surface.

dAvePi's pitch overlaps in the "no hand-written CRUD" axis but
diverges on shape: one JS file per resource becomes REST +
GraphQL + MCP + a typed client + an admin SPA simultaneously,
Mongo-backed, with the framework absorbing many features
(state machines, audit, idempotency, file fields) as schema
options rather than as application-side wiring.

## At a glance

| Feature | dAvePi | Hasura |
|---------|--------|--------|
| Database | MongoDB only | Postgres / MS SQL / Citus / BigQuery / Snowflake |
| Primary API | REST + GraphQL + MCP (equal weight) | GraphQL first; REST via Actions / Endpoints (added later) |
| MCP / agent surface | First-class (HTTP + stdio); `_describe` manifest | None built-in |
| Schema definition | One JS file per resource under `schema/versions/v1/` | Introspected from the DB schema; permissions in metadata |
| Hot reload | Yes (dev) | Console-driven; metadata reload on apply |
| ACL model | Document + field-level `acl: {…}` on the schema | Roles + row/column permission rules per table |
| Audit log | Default-on, per-record diff, queryable | Event triggers (you wire them) |
| Soft delete + restore | Default-on with `restore_*` MCP tool | App-side convention |
| File uploads | `type: 'File'` field | Not in scope (use external storage) |
| Computed fields | `computed: (r) => …` at response time | Generated columns / computed-field tracking via SQL functions |
| Relations | Declarative `belongsTo` / `hasMany`; batched `__include` | Auto-detected from FKs; manually-defined remote relationships |
| State machines | Per-field `stateMachine` with validated transitions + generated mutation | App-side (or check constraints + triggers) |
| Idempotency | Stripe-style `Idempotency-Key` on every POST | Not built in |
| Typed client | `davepi gen-client` per-resource TS interfaces | Codegen from GraphQL schema (graphql-codegen, etc.) |
| Admin UI | Refine-based SPA, auto-rendered from `_describe` | Console (web app, for ops not end-users) |
| Auth | JWT + refresh, roles in JWT claim | JWT-based, roles in claims; Auth Hooks / Webhooks |
| Hosting | Bring your own | Hasura Cloud + self-host (CE/EE) |

## What's similar

Both generate API surfaces from a schema rather than asking you
to hand-write resolvers / controllers. Both use JWT claims to
drive authorisation. Both ship a console / admin UI for
operators. Both expose webhooks / event triggers for change
notification.

## Where dAvePi wins

- **REST and GraphQL co-equal, not GraphQL-first.** Hasura's REST
  surface came later (Actions, then REST Endpoints) and remains a
  secondary citizen. dAvePi auto-generates a full REST + GraphQL
  + MCP triplet from the same schema file, with the same
  capabilities behind each.
- **Agent surface built in.** MCP tools per schema, `_describe`
  manifest, idempotency keys, typed errors with `recoverable`
  flags. To get this on Hasura you'd write a custom MCP server
  that proxies its GraphQL — not impossible, but it's a
  layered build-out.
- **Schema vocabulary covers more.** State machines, audit log,
  soft delete + restore, idempotency, computed fields, file
  fields, retention sweeps, ACL — all schema-level in dAvePi.
  Hasura covers permissions and event triggers natively but the
  rest are "wire it in your app" territory.
- **Single-source-of-truth at the language level.** A JS file is
  the schema. No console state, no metadata directory to
  maintain alongside the database. Edit, save, hot reload picks
  it up.
- **Typed errors with `code`.** dAvePi returns
  `{ error: { code, message, details? } }` consistently. Hasura's
  GraphQL errors carry an `extensions.code` and are well-shaped,
  but the REST surface's error shape varies by endpoint type
  (Action vs. REST Endpoint vs. Health).

## Where Hasura wins

- **SQL backend choice.** Hasura federates across Postgres, MS
  SQL, BigQuery, Snowflake, Citus, Cockroach, and more. dAvePi
  is Mongo-only.
- **Permissions UI.** Console-driven, role-based row/column
  rules. For teams whose access policies live in a permissions
  matrix maintained by non-developers, that UI is the right
  shape. dAvePi's ACL is code-in-the-schema.
- **GraphQL maturity.** Federation, remote schemas, subscriptions
  via Postgres logical replication, relay-style connections,
  introspection tooling. dAvePi exposes GraphQL via
  graphql-compose but doesn't federate or remote-schema.
- **Performance under load.** Hasura's query compiler is built
  for SQL-shaped joins and has had years of work on N+1 avoidance
  via the JOIN/SELECT compiler. dAvePi batches relations but the
  ceiling on complex multi-resource queries is lower.
- **Enterprise auth.** SAML, fine-grained API limits, multiple
  JWT providers, audit trails of console actions. dAvePi ships
  JWT + refresh; enterprise auth is a build-your-own.

## Pick Hasura if…

- You're already on Postgres / MS SQL / Snowflake / BigQuery and
  want a GraphQL surface over the existing schema.
- You need federation, remote schemas, or cross-DB queries.
- Permissions are managed by non-developers via a UI.
- You want a hosted offering with auto-scaling on a managed
  GraphQL stack.

## Pick dAvePi if…

- You want REST and GraphQL co-equal — not GraphQL with
  bolted-on REST.
- You're building for AI agents and want MCP tools + a discovery
  manifest without writing a proxy server.
- You'd rather have the framework own state machines, audit,
  idempotency, soft delete, and computed fields than wire them
  into app code on top of GraphQL.
- You prefer Mongo's document model for nested / dynamic data.
- You want a single deployable Node process you fully control.

## Migration sketch

Hasura → dAvePi:

1. **Tables → schema files.** Each table or Hasura tracked entity
   becomes `schema/versions/v1/<resource>.js`. Columns map to
   `fields[]`; `userId` is the dAvePi tenant column.
2. **Relationships → relations map.** Hasura's
   object/array relationships translate to `belongsTo` /
   `hasMany` entries with explicit `fk:` names.
3. **Permissions → ACL.** Row-level select / insert / update /
   delete rules map to dAvePi's `acl.list` (cross-tenant reads)
   and `acl.delete` (cross-tenant deletes). Column permissions
   become `field.acl.read` / `acl.create` / `acl.update`. Hasura's
   "owner" pattern (`X-Hasura-User-Id`) is the default in dAvePi
   (the tenant column does it automatically).
4. **Event triggers → webhooks.** dAvePi's
   `schema.webhooks` block fires on create / update / delete /
   restore / transition with HMAC-signed payloads.
5. **Custom mutations / Actions → custom routes.** Move Actions
   into `index.js` after `require('davepi')` (use
   `app.locals.schemaLoader` for shared helpers). Most Actions
   that just hit an external API stay external; only the ones
   that needed the GraphQL surface need rewriting.
6. **Data.** Postgres → Mongo migration via your ETL of choice;
   most rows map 1:1 once the schema is in place.

## See also

- [Schema-driven generation](/concepts/schema-driven/)
- [GraphQL surface](/surfaces/graphql/)
- [Other comparisons](/compared-to/)
