---
title: dAvePi vs. Directus
description: Node-based, database-agnostic platform that sits on top of an existing SQL database. Heavy admin UI focus and a "your data, our admin" pitch. dAvePi takes the opposite tack — schema-as-code, generated typed surfaces, agent-first.
---

Directus is a Node platform that connects to an existing SQL
database — Postgres, MySQL, SQLite, MS SQL, OracleDB — and
exposes REST + GraphQL APIs auto-generated from the database
schema. The admin UI is a major feature: a polished, customisable
operator console with flows (visual automation), data
visualisation, file management, and a permission editor.

The "introspect an existing DB" angle is the key differentiator:
you can point Directus at a database that already has data and a
team running it, and get an admin + API surface for free without
rewriting the schema.

dAvePi has the opposite shape: you write the schema in code,
the framework owns the storage (Mongo only), and the auto-generated
surfaces include MCP + a typed TS client + a generated admin SPA
on top of REST + GraphQL.

## At a glance

| Feature | dAvePi | Directus |
|---------|--------|----------|
| Runtime | Node + MongoDB | Node + Postgres / MySQL / SQLite / MS SQL / OracleDB |
| Schema source | JS files under `schema/versions/v1/` | Introspected from the existing DB; collections + fields managed via admin |
| Brings its own DB | Yes (Mongo) | No — points at your existing DB |
| API | REST + GraphQL + MCP | REST + GraphQL |
| MCP / agent surface | First-class (HTTP + stdio); `_describe` manifest | None built-in |
| Hot reload | Yes (dev) | Schema changes apply on admin save |
| ACL model | Document + field-level `acl: {…}` on the schema | Roles + per-collection policies + field permissions |
| Audit log | Default-on, per-record diff | Built-in activity log (per-action audit) |
| Soft delete + restore | Default-on with `restore_*` MCP tool | Optional via a "soft-delete" config per collection |
| File uploads | `type: 'File'` field; local / S3 / GCS | Files & assets (with transforms) |
| Computed fields | `computed: (r) => …` at response time | Alias fields + custom field interfaces |
| Relations | Declarative `belongsTo` / `hasMany`; batched | M2O / O2M / M2M with deep query support |
| State machines | Per-field, generated mutation, audit on transition | App-side or via Flows |
| Idempotency | Stripe-style `Idempotency-Key` | Not built in |
| Typed client | `davepi gen-client` per-resource TS interfaces | `@directus/sdk` (typed via codegen from schema) |
| Admin UI | Refine-based SPA, auto-rendered from `_describe`. Developer-facing. | First-party admin (the killer feature) |
| Flows / automation | State-machine `onEnter` + webhooks | Visual flow builder, scheduled, hooks, batch ops |
| Auth | JWT + refresh, `/login` / `/register` | OAuth, SAML, SSO, MFA, multiple providers |
| Hosting | Bring your own | Directus Cloud + self-host |

## What's similar

Both auto-generate REST + GraphQL from declared schemas. Both
ship a working admin UI. Both support file uploads, relations,
and role-based access. Both treat the admin UI as a major
product surface.

## Where dAvePi wins

- **Agent surface.** MCP, `_describe`, idempotency, typed errors.
  Directus has no MCP integration story today.
- **State machines, audit, soft delete, idempotency, computed
  fields.** All as schema vocabulary in dAvePi. Directus has
  audit (activity log) and soft-delete-per-collection, but state
  machines and idempotency require Flows or app-side wiring.
- **Schema as code.** Directus's primary schema management is
  through the admin UI; the same DB state is the source of
  truth, which makes branching / PR review of schema changes
  awkward. dAvePi's schema-as-a-file approach makes schema
  changes diffable and reviewable in code.
- **Typed TS client.** Auto-generated per-resource interfaces
  including state-machine enum unions and computed-field types.
  Directus's SDK + codegen path works but is a separate flow.

## Where Directus wins

- **"Point at an existing DB" is the killer use case.** Directus
  reads the introspectable SQL schema and gives you an admin +
  API surface for it. If you have a Postgres database that
  predates this conversation — a Rails app, a legacy reporting
  warehouse, anything — Directus is the way to get an admin
  surface over it without rewriting. dAvePi can't do this.
- **Database breadth.** Postgres, MySQL, SQLite, MS SQL,
  OracleDB. dAvePi is Mongo-only.
- **Admin UI maturity.** Custom field interfaces, custom layouts,
  display formatters, panel-based dashboards, presentation
  options per collection. dAvePi's Refine-based admin is
  capable but doesn't reach Directus's "no-code data product"
  ceiling.
- **Flows.** Visual workflow / automation builder with
  scheduling, batch ops, multi-step orchestration, and an event
  hook system. dAvePi's equivalent (state-machine `onEnter` +
  webhooks) is code-driven.
- **Auth breadth.** OAuth, SAML, SSO, MFA, multiple providers,
  shared sessions. dAvePi ships JWT + refresh + password reset.
- **Hosted offering.** Directus Cloud handles deploy and DB.

## Pick Directus if…

- You have an existing SQL database you want an admin + API
  surface over without rewriting.
- The admin UI is a primary feature (operator-facing, no-code
  data product, internal-tool kind of work).
- You need visual automation (Flows), scheduled jobs, or
  enterprise auth (SAML / SSO / MFA).
- You want a SQL backend.
- Multi-DB support matters (Postgres → MySQL → SQLite portability,
  or accessing multiple DB types from one stack).

## Pick dAvePi if…

- You're building from scratch and writing the schema anyway.
- You're building for AI agents and want first-class MCP tooling.
- You want state machines, audit, idempotency, computed fields
  as framework primitives rather than custom Flows / app code.
- You prefer schema-as-code over schema-as-admin-UI.
- You want a typed TS client generated from the schema map.

## Migration sketch

Directus → dAvePi:

1. **Collections → schema files.** Each Directus collection
   becomes a `schema/versions/v1/<resource>.js`. The field type
   mapping is similar to other SQL→Mongo migrations:
   - `string` / `text` → `String`
   - `integer` / `bigInteger` / `float` / `decimal` → `Number`
   - `boolean` → `Boolean`
   - `datetime` / `date` / `time` → `Date`
   - `json` → `Mixed` or a nested sub-schema
   - `m2o` / `o2m` / `m2m` → plain `String` FK + `relations` entry
   - `file` / `files` → `type: 'File'`
2. **Permissions → ACL.** Directus's role-based collection
   permissions map to `acl.list` / `acl.delete` (document level)
   and `field.acl.{read,create,update}` (field level).
3. **Activity log → audit.** dAvePi's audit log writes
   automatically once `audit: true` (the default) is set on the
   schema.
4. **Flows → webhooks + state machines.** Single-event Flows
   become `webhooks` entries; per-state-arrival Flows become
   `stateMachine.onEnter['…']` handlers.
5. **File assets.** Move from Directus's storage adapter to
   your chosen dAvePi backend; update file metadata
   sub-documents to point at the new keys.
6. **Auth.** Re-issue tokens via `/register`. SSO migrations
   are not in dAvePi's scope today — plan for password-reset
   flows or a custom auth path.

The full guide — collection mapping, permissions, Flows
decomposed into webhooks + state-machine `onEnter` handlers, file
asset move, ETL template, cutover checklist — is at
[Migrate from Directus](/migrate-from/directus/).

## See also

- [Migrate from Directus](/migrate-from/directus/) — the full
  migration guide.
- [Schema-driven generation](/concepts/schema-driven/)
- [Schema file shape](/reference/schema/)
- [Other comparisons](/compared-to/)
