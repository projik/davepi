---
title: dAvePi vs. PocketBase
description: Single-binary Go backend with SQLite and a built-in schema admin UI. Minimal, fast, beloved for solo / hobbyist projects. dAvePi covers more of the production surface at the cost of more moving parts.
---

PocketBase is a single Go binary plus a SQLite database. You
download one executable, point a browser at it, and define
collections (schemas) through the admin UI. REST routes, auth,
realtime subscriptions, and file uploads come out of the box.
The whole thing weighs in at ~30MB total and runs anywhere.

dAvePi is a much larger surface in exchange for a different
production posture: REST + GraphQL + MCP + typed client + admin
SPA from one schema file, state machines / audit / idempotency /
ACL built in, Node + Mongo runtime. Heavier, but covers more of
what production apps need without app-side glue.

## At a glance

| Feature | dAvePi | PocketBase |
|---------|--------|------------|
| Runtime | Node.js + MongoDB | Single Go binary (~30MB), SQLite embedded |
| API | REST + GraphQL + MCP | REST + realtime |
| MCP / agent surface | First-class (HTTP + stdio); `_describe` manifest | None built-in |
| Schema definition | One JS file per resource | Collections defined in the admin UI (or JS migrations) |
| Hot reload | Yes (dev) | Schema applies on save in the admin UI |
| ACL model | Document + field-level on the schema | API rules (one expression per CRUD verb) per collection |
| Audit log | Default-on, per-record diff | None built-in |
| Soft delete + restore | Default-on with `restore_*` MCP tool | None built-in (you wire a `deleted` flag) |
| File uploads | `type: 'File'` field; local / S3 / GCS | File-type field; local storage by default, S3 supported |
| Computed fields | `computed: (r) => …` at response time | None |
| Relations | Declarative `belongsTo` / `hasMany`; batched `__include` | `relation` field type, expansion via `?expand=` |
| State machines | Per-field, generated mutation, audited transitions | None built-in |
| Idempotency | Stripe-style `Idempotency-Key` | Not built in |
| Typed client | `davepi gen-client` per-resource TS interfaces | Official JS SDK + a few community-typed ones |
| Admin UI | Refine-based SPA, auto-rendered from `_describe` | First-party admin (the killer feature) |
| Realtime | Outbound webhooks for change events | WebSocket subscriptions per collection |
| Auth | JWT + refresh, `/login` / `/register` | Email/password, OAuth, magic link, anonymous |
| Hosting | Bring your own | Bring your own — single binary, anywhere |

## What's similar

Both auto-generate CRUD endpoints from declared schemas. Both
ship a working admin UI. Both support file fields, relations,
and role-based access. Both have a "you point your frontend
at it and it works" out-of-box experience.

## Where dAvePi wins

- **State machines, audit log, soft delete, idempotency,
  computed fields.** All built in as schema vocabulary. In
  PocketBase these are either missing or "wire it in app code".
- **Agent surface.** MCP tools per resource, `_describe` for
  one-round-trip capability discovery, typed errors with
  `recoverable`. PocketBase has no MCP integration story today.
- **GraphQL.** PocketBase is REST + realtime only — no GraphQL
  surface. dAvePi exposes both, generated from the same schema.
- **Schema as code.** PocketBase's primary schema editor is the
  admin UI; JS migrations exist but the canonical pattern is
  click-to-define. dAvePi's schema-as-a-file path is friendlier
  to code review, branching, and AI-agent-driven changes (which
  is most of the eval suite).
- **Typed client.** A first-class TS client generated from the
  schema map. PocketBase's official JS SDK is untyped at the
  per-record level (you supply your own types).
- **Audit + retention.** Default-on per-record audit trail with
  field-level diffs and retention sweeps. To get this in
  PocketBase you'd add a hook that writes audit rows, build the
  query endpoint, and wire retention manually.

## Where PocketBase wins

- **Operational simplicity.** Single binary. No database to run,
  no Node version to pin, no `npm install`. SQLite means
  backups are a file copy. Self-host on a $5 VPS, your laptop,
  or an embedded device.
- **Resource footprint.** ~30MB binary, single-process Go,
  minimal runtime overhead. dAvePi pulls in Node + Mongo, which
  is a meaningful step up in memory / disk / boot time.
- **First-party admin UI.** PocketBase's admin is one of its
  best features — polished, opinionated, and works with no
  configuration. dAvePi ships a Refine-based admin SPA, but
  it's an extra build step (`npm run build:admin`).
- **Realtime WebSockets.** Native subscriptions to row changes.
  dAvePi pushes change events via outbound webhooks; clients
  poll or use a webhook-receiver service for similar effect.
- **Authentication breadth.** OAuth, magic link, anonymous
  sign-in, email confirmation, password reset flows — all
  built in. dAvePi ships JWT + refresh + password reset; broader
  auth flows are app-side.
- **Single-binary deploy.** No Docker compose, no Mongo
  container, no `npm install` on the server.

## Pick PocketBase if…

- You're building a side project, prototype, or single-tenant
  app where simplicity is the value.
- You want WebSocket realtime out of the box.
- You want to deploy to a Raspberry Pi / $5 VPS / Fly micro VM
  and forget about it.
- The schema is small enough that the UI editor is faster than
  writing JS files.
- You want a polished admin UI as a primary feature.

## Pick dAvePi if…

- You're building for AI agents and want MCP integration without
  proxying a custom server.
- The app will need state machines, audit logs, multi-tenant
  ACL, or other production-shaped features — and you'd rather
  the framework handle them than wire them in app code.
- You need GraphQL alongside REST.
- The schema is large enough that "file per resource" is faster
  than clicking through an admin UI.
- You want a generated typed TS client driving frontend
  development.

## Migration sketch

PocketBase → dAvePi:

1. **Export collections.** Use PocketBase's admin → settings →
   backup, or the API to dump records to JSON.
2. **Collection → schema file.** Each collection becomes a
   `schema/versions/v1/<name>.js`. PocketBase field types map
   pretty directly:
   - `text` / `email` / `url` → `String`
   - `number` → `Number`
   - `bool` → `Boolean`
   - `date` → `Date`
   - `relation` → a plain `String` FK + a `relations` entry
   - `file` → `type: 'File'` with the `accept` / `maxBytes` from
     the original config.
3. **API rules → ACL.** PocketBase's per-CRUD-verb expressions
   roughly map to dAvePi's `acl.list` / `acl.delete` (document
   level) and field-level `acl.read` / `acl.create` /
   `acl.update`. "@request.auth.id = id" is the default
   owner-only mode — no policy needed in dAvePi.
4. **Auth.** Re-register users; password hashes don't migrate
   directly. A one-time password-reset flow is the usual path.
5. **Realtime subscribers.** Switch from PocketBase's WebSocket
   `subscribe()` to dAvePi's outbound webhooks for change events,
   or poll the relevant resource if push isn't strictly required.

The full guide — collection-to-schema mapping, API-rule
translation, SQLite ETL, realtime → webhook relay, cutover
checklist — is at [Migrate from PocketBase](/migrate-from/pocketbase/).

## See also

- [Migrate from PocketBase](/migrate-from/pocketbase/) — the
  full migration guide.
- [Schema-driven generation](/concepts/schema-driven/)
- [Idea to deployed CRM in 10 minutes](/guides/crm-in-10-minutes/)
- [Other comparisons](/compared-to/)
