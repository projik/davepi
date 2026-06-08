---
title: dAvePi vs. Supabase
description: Postgres-based BaaS with auth, storage, realtime, and edge functions. Closest direct competitor to dAvePi in the "schema → API" space, but the architectural choices diverge meaningfully.
---

Supabase is a hosted Postgres-based backend with auth, storage,
realtime subscriptions, and edge functions bolted on. PostgREST
auto-generates REST endpoints from the SQL schema; row-level
security (RLS) is the primary access-control mechanism.

dAvePi takes a different shape: one schema file per resource
becomes REST + GraphQL + MCP + a typed client + an admin SPA + a
capability manifest, all kept in lockstep by a single source of
truth. Mongo-backed instead of Postgres. JWT auth and
framework-level ACL instead of RLS. Agent-first surface (MCP +
`_describe`) instead of TypeScript SDK + JS client only.

## At a glance

| Feature | dAvePi | Supabase |
|---------|--------|----------|
| Database | MongoDB only | Postgres (with extensions) |
| REST | Auto-generated per schema | PostgREST, auto-generated from the SQL schema |
| GraphQL | Auto-generated per schema | `pg_graphql` extension (experimental in many setups) |
| MCP / agent surface | First-class (HTTP + stdio); `_describe` manifest | None built-in |
| Schema-driven | One JS file per resource | SQL migrations + GUI table editor |
| Hot reload | Yes (dev) | Migrations apply on change; PostgREST reloads on signal |
| ACL model | Document + field-level `acl: {…}` declared on the schema | Postgres RLS policies (SQL) |
| Audit log | Default-on, per-record diff, queryable via `history_*` MCP tool | DB triggers (you wire them) |
| Soft delete + restore | Default-on with `restore_*` MCP tool | Convention (`deleted_at`) — you wire it |
| File uploads | `type: 'File'` field with `maxBytes` / `accept` | Storage service with bucket policies |
| Computed fields | `computed: (record) => …` at response time | Generated columns / views in SQL |
| Relations | Declarative `belongsTo` / `hasMany`; batched `__include` | Foreign keys + PostgREST embeds |
| State machines | Per-field `stateMachine: {…}` with validated transitions + GraphQL mutation | Triggers or check constraints (you wire them) |
| Idempotency | Stripe-style `Idempotency-Key` on every POST | Not built in |
| Typed client | `davepi gen-client` emits per-resource TS interfaces | `supabase-js` (manually-written typings or `supabase gen types`) |
| Admin UI | Refine-based SPA, auto-rendered from `_describe` | Studio (web app) |
| Realtime | Webhooks for change events | Postgres logical replication + WebSockets |
| Auth | JWT + refresh, `/login` / `/register`, JWT claim-based roles | Email/password, OAuth, magic link, MFA, etc. |
| Hosting | Bring your own | Hosted SaaS + self-host (Docker) |

## What's similar

Both pitch "stop writing CRUD endpoints." Both give you
auto-generated read/write surfaces against your schema. Both
support file uploads, custom hooks (Supabase via Postgres
triggers / edge functions; dAvePi via webhooks + state-machine
`onEnter` hooks), and a typed client. Both expose a JS / TS SDK
that frontend code can call directly.

## Where dAvePi wins

- **Agent-first surface.** MCP tools per schema, a compact
  `_describe` manifest, typed errors with `recoverable` flags,
  idempotency built into every `POST`. Supabase has no equivalent
  agent integration today — you'd write tool wrappers manually
  against `supabase-js`.
- **Schema as a single source.** Add `searchable: true` to a
  field and you get a full-text index, a `q` query parameter, a
  `search_*` MCP tool, a search method on the typed client, and a
  surfaced flag in `_describe` — without writing the SQL trigger
  or wiring an extension.
- **State machines as a first-class concept.** Declare states +
  transitions in the schema; the framework generates the
  validated GraphQL mutation, audit rows on transition, and
  `availableTransitions` virtuals on every read. Supabase pushes
  this into application logic or check constraints.
- **Per-record audit log + soft delete defaults.** Both behaviours
  are on by default with no setup; the audit log is queryable as
  a first-class endpoint (REST `/:id/history`, MCP `history_*`).
- **Idempotency contract.** Stripe-style key handling at the
  framework level closes the duplicate-on-retry class of bugs
  without per-route code.

## Where Supabase wins

- **Ecosystem and maturity.** Years of production deployments,
  large community, broad plugin / template ecosystem, mature
  hosted offering, mature client libraries for many languages.
- **Postgres power.** SQL joins, window functions, materialised
  views, JSONB, PostGIS, full-text search via tsvector,
  extensions like `pgvector`. If your data shape is genuinely
  relational or you need geospatial / vector / time-series, the
  whole Postgres extension catalogue is available.
- **Auth flow breadth.** Magic links, OAuth across many providers,
  MFA, SSO, anonymous sign-ins, phone OTP. dAvePi ships
  JWT + refresh tokens and `/login` / `/register`; broader auth
  is a build-your-own.
- **Realtime subscriptions.** Logical-replication-based WebSocket
  subscriptions to row changes. dAvePi pushes change events via
  outbound webhooks but doesn't have a built-in WebSocket
  subscription surface.
- **Storage / CDN integration.** Storage buckets with built-in
  CDN and image transforms. dAvePi's file fields support local /
  S3 / GCS storage but no CDN configuration of its own.
- **Hosted offering.** A free tier and a managed-database path
  with the platform team operating Postgres for you.

## Pick Supabase if…

- Your team and infrastructure is already SQL-shaped.
- You want a hosted offering you don't operate.
- You need realtime row-level subscriptions, broad OAuth, or
  Postgres extensions like PostGIS / pgvector.
- The schema's complexity lives in SQL idioms (CTEs, window
  functions) rather than in declarative resource shapes.

## Pick dAvePi if…

- You're building for AI agents (Claude Desktop / Cursor / Claude
  Code) and want first-class MCP tooling without writing
  integration glue.
- You want one schema file to drive REST, GraphQL, MCP, the
  typed client, the admin UI, and a typed error surface in lockstep.
- The framework's built-in features (state machines, audit log,
  idempotency, soft delete, ACL) cover most of what you'd be
  adding manually elsewhere.
- You prefer Mongo's document model for the data shape (nested
  records, dynamic fields, JSON-native).
- You want a single-process deploy you fully control rather than
  a hosted SaaS dependency.

## Migration sketch

Supabase → dAvePi:

1. **Export.** `pg_dump` each table, or use the Supabase Studio
   table export to CSV / JSON.
2. **Schema mapping.** Each Postgres table becomes a
   `schema/versions/v1/<table>.js`. Columns → `fields[]` entries.
   `userId` becomes the tenant column (dAvePi auto-stamps it from
   the JWT).
3. **RLS → ACL.** Translate row-level security policies to dAvePi's
   `acl.list` / `acl.write` / `acl.delete` slots (document-level) or
   per-field `acl.read` / `acl.create` / `acl.update`. RLS that's just
   "user owns their rows" is the default in dAvePi — no policy needed.
4. **Auth.** Re-issue tokens via `/register`. Password hashes
   don't migrate cleanly (bcrypt vs Supabase's scrypt); plan a
   one-time password reset flow.
5. **File storage.** Move bucket contents to your chosen dAvePi
   storage backend (S3 / GCS / local); update the metadata
   sub-documents to point at the new keys.
6. **Realtime subscribers.** Switch from `supabase.channel(...)`
   to outbound webhooks (dAvePi's `schema.webhooks` block) or
   poll the relevant aggregation endpoints.

The full end-to-end walkthrough — including the ETL script
template, FK-rewrite pass, file-storage move, and cutover
checklist — is at [Migrate from Supabase](/migrate-from/supabase/).

## See also

- [Migrate from Supabase](/migrate-from/supabase/) — the
  full end-to-end migration guide.
- [Schema-driven generation](/concepts/schema-driven/) — the
  framework's central idea.
- [Why agents come first](/concepts/agent-first/) — the design
  rationale for the MCP-first surface.
- [Other comparisons](/compared-to/).
