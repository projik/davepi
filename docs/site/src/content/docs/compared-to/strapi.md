---
title: dAvePi vs. Strapi
description: Node-based headless CMS with a strong admin-UI focus and a plugin ecosystem. Different center of gravity than dAvePi — Strapi optimises for non-developer content editors, dAvePi for developers and agents.
---

Strapi is a Node-based headless CMS. The schema is defined in
its admin UI (or via the content-types builder), REST + GraphQL
endpoints are generated, and a polished editor-facing admin
handles publishing, drafts, media, and role-based publishing
workflows. The plugin ecosystem is large and the product is
shaped for non-developer content editors as the primary user
of the admin.

dAvePi shares the "schema → API" idea but optimises differently:
schema is JS code, the admin SPA is developer-facing
(operate-the-data, not author-the-content), and the framework
absorbs production features (state machines, audit log,
idempotency, MCP) that Strapi leaves to plugins or app code.

## At a glance

| Feature | dAvePi | Strapi |
|---------|--------|--------|
| Runtime | Node + MongoDB | Node + Postgres / MySQL / SQLite / Mongo |
| API | REST + GraphQL + MCP | REST + GraphQL (plugin) |
| MCP / agent surface | First-class (HTTP + stdio); `_describe` manifest | None built-in |
| Schema definition | One JS file per resource | Content-Type Builder (admin UI) or generator CLI |
| Hot reload | Yes (dev) | Restart on schema change |
| ACL model | Document + field-level `acl: {…}` on the schema | Roles + permissions table managed in the admin |
| Audit log | Default-on, per-record diff | Plugin (audit-logs in EE) |
| Soft delete + restore | Default-on with `restore_*` MCP tool | Draft / publish lifecycle (different concept) |
| File uploads | `type: 'File'` field; local / S3 / GCS | Media library plugin (extensive) |
| Computed fields | `computed: (r) => …` at response time | None native (use lifecycle hooks) |
| Relations | Declarative `belongsTo` / `hasMany`; batched | Built-in (one-way / two-way, polymorphic) |
| State machines | Per-field, generated mutation, audit on transition | App-side or via custom routes |
| Idempotency | Stripe-style `Idempotency-Key` | Not built in |
| Typed client | `davepi gen-client` per-resource TS interfaces | TypeScript types generated from schemas (manual call) |
| Admin UI | Refine-based SPA, auto-rendered from `_describe`. Developer-facing. | First-party admin, content-editor-facing |
| Internationalisation | None built in | i18n plugin (core feature) |
| Draft / publish workflow | None — state machines cover it | Built-in (draft + publish state per record) |
| Auth | JWT + refresh, `/login` / `/register`, roles in claim | Users & Permissions plugin; multiple providers |
| Hosting | Bring your own | Strapi Cloud + self-host |

## What's similar

Both are Node-based. Both auto-generate REST and GraphQL surfaces
from declared content shapes. Both ship a working admin UI. Both
support file uploads, relations, and role-based access. Both
have a plugin / extension hook somewhere in the lifecycle.

## Where dAvePi wins

- **Agent surface.** MCP, `_describe`, idempotency, typed errors.
  Strapi has no MCP integration today.
- **State machines, audit, soft delete, idempotency.** All
  schema-level vocabulary in dAvePi. State machines in particular
  are first-class with generated mutations + `availableTransitions`
  virtuals — Strapi's draft/publish is a fixed two-state version
  of the same idea, but anything beyond that is custom.
- **Schema as code by default.** Strapi's primary editor is the
  admin UI, with the JSON model file as a side effect. dAvePi's
  schema is the JS file — friendlier to PR review, branching,
  and AI-agent-driven changes.
- **Typed TS client out of the box.** `davepi gen-client` emits
  per-resource interfaces, including computed-field types and
  state-machine enum unions. Strapi has TypeScript type
  generation but it's a separate flow you remember to run.

## Where Strapi wins

- **Admin UX for content editors.** Strapi's admin is
  purpose-built for non-developer users: rich-text editors,
  media library, draft / publish workflows, scheduled publishing,
  i18n, preview modes. dAvePi's admin SPA is developer-facing
  (operate the data, not author content) — wrong tool for a
  marketing team managing blog posts.
- **Plugin ecosystem.** Hundreds of plugins for common needs
  (email, payments, search providers, i18n, GraphQL extensions,
  custom field types). dAvePi's ecosystem is small and
  intentional.
- **i18n.** First-class internationalisation with per-locale
  field values. dAvePi has no equivalent today — you'd model
  i18n in your schema (e.g. a `translations` field).
- **Draft / publish.** Two-state lifecycle on every entry with
  preview support. dAvePi can model this with a `state` machine
  (`draft → published → archived`) but the UI / preview
  ergonomics aren't there.
- **Backend database choice.** Strapi supports Postgres, MySQL,
  SQLite, and Mongo. dAvePi is Mongo-only.
- **Hosted offering.** Strapi Cloud manages the deploy /
  upgrade / DB lifecycle. dAvePi is bring-your-own-host.

## Pick Strapi if…

- The app is a content-management problem: blog posts, marketing
  pages, product catalogues — anywhere content editors are the
  primary users of the admin.
- You need i18n, draft/publish workflows, scheduled publishing,
  or rich-text content editing as core features.
- The team includes non-developer admin users.
- You want a SQL backend (Postgres / MySQL).
- You want a hosted offering.

## Pick dAvePi if…

- The app is an operational system: SaaS dashboards, internal
  tools, B2B CRUD apps — anywhere developers and agents are the
  primary users of the API.
- You're building for AI agents and want first-class MCP tooling.
- You want state machines, audit log, idempotency, ACL as
  framework features rather than as plugins or app code.
- You want REST and GraphQL co-equal, generated from the same
  schema source.
- You prefer schema-as-code over schema-as-admin-UI.

## Migration sketch

Strapi → dAvePi:

1. **Content types → schema files.** Each Strapi content type
   becomes a `schema/versions/v1/<resource>.js`. Strapi's
   attribute types map cleanly:
   - `string` / `text` / `email` → `String`
   - `integer` / `decimal` → `Number`
   - `boolean` → `Boolean`
   - `date` / `datetime` → `Date`
   - `relation` → plain `String` FK + a `relations` entry
   - `media` → `type: 'File'` with the relevant `accept` /
     `maxBytes` from the original config.
   - `enumeration` → `enum: [...]` on a `String` field, or a
     state machine if you want validated transitions.
2. **Draft/publish → state machine.** Replace Strapi's
   draft/publish lifecycle with a `state: String, stateMachine:
   { initial: 'draft', states: ['draft', 'published',
   'archived'], transitions: {...} }` field. The state-machine
   mutation gives you validated state changes the same way
   Strapi's publish action does.
3. **Permissions → ACL.** Strapi's roles+permissions table
   maps to dAvePi's `acl.list` / `acl.delete` and field-level
   `acl.read` / `acl.create` / `acl.update`.
4. **Media library.** Move files from Strapi's
   `public/uploads/` to your chosen dAvePi storage backend;
   update the file metadata sub-documents to the new keys.
5. **Lifecycle hooks → webhooks / state machine `onEnter`.**
   Hooks that fired on `afterCreate` / `afterUpdate` translate
   to outbound webhooks. Hooks on a specific draft→published
   transition translate to `stateMachine.onEnter['published']`.
6. **i18n.** No direct map; either build a `translations` field
   per-resource or stick with Strapi for now if i18n is core to
   the product.

## See also

- [Schema-driven generation](/concepts/schema-driven/)
- [State machines](/features/state-machines/)
- [Other comparisons](/compared-to/)
