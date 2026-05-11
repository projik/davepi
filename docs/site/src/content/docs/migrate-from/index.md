---
title: Migrating to dAvePi
description: Per-source migration guides — schema mapping, ETL templates, auth re-issue. Pick the platform you're leaving.
---

You have data already. These guides cover the move into dAvePi
from the platforms most teams are leaving — schema mapping, ETL
script template, auth migration, and feature-by-feature notes on
how the source's primitives translate to dAvePi's.

| From | Schema model | Auth | What gets rewritten |
|------|--------------|------|---------------------|
| [Supabase](/migrate-from/supabase/) | Postgres tables + RLS | Email/password, OAuth, magic link | Tables → schema files, RLS → ACL, buckets → file fields |
| [Hasura](/migrate-from/hasura/) | Tracked Postgres tables + permission rules | JWT (claims-driven) | Tracked entities → schema files, permissions → ACL, event triggers → webhooks |
| [PocketBase](/migrate-from/pocketbase/) | Collections (admin-UI defined) | Email/password, OAuth | Collections → schema files, API rules → ACL, WebSockets → webhooks |
| [Strapi](/migrate-from/strapi/) | Content types (admin-UI defined) | Users & Permissions plugin | Content types → schema files, draft/publish → state machine, plugins → custom routes |
| [Directus](/migrate-from/directus/) | Introspected SQL tables | OAuth, SAML, SSO | Collections → schema files, permissions → ACL, Flows → state-machine `onEnter` + webhooks |

## What's the same in every migration

Whichever source you're leaving, the shape of the move is:

1. **Stand up dAvePi against an empty database.** `npx create-davepi-app acme-api` gets you a runnable server.
2. **Write the schema files.** One JS file per source collection / table under `schema/versions/v1/`. The per-source guide has the field-type mapping table.
3. **Re-create users.** Passwords don't migrate cleanly from anywhere (different hash algorithms / cost factors); plan a one-time password-reset email for every user.
4. **Backfill data with the ETL template.** Each guide ships a Node script — read source dump, transform per-row, `bulkWrite` into the target collection.
5. **Cut over reads.** Run dAvePi alongside the old system; gradually move traffic. Read consistency is a per-table cutover, not a big-bang flip.
6. **Cut over writes.** Once reads are stable and the data delta is small, point writes at dAvePi. Tear down the source.

## Things that don't migrate, ever

These are platform-specific and have no direct equivalent — you'll need an alternative strategy:

- **Password hashes.** dAvePi uses bcrypt (rounds=10) for new users. Any source using a different algorithm (Supabase's scrypt, PocketBase's variants, Argon2 from custom auth) won't move. Force-reset everyone on cutover. The `/auth/forgot-password` + `/auth/reset-password` endpoints are built in.
- **Realtime WebSocket subscriptions.** Supabase / PocketBase push row changes over WebSockets. dAvePi pushes change events via outbound HMAC-signed webhooks instead. Frontend code that uses `supabase.channel(...)` or `pb.collection(...).subscribe(...)` needs reworking — either move to polling, or have your frontend listen to a websocket relay that's fed by the webhook.
- **i18n.** No direct map. If you're using Strapi's i18n plugin or Directus's translations, you'll model translations explicitly (a `translations: { [locale]: ... }` sub-document, or per-locale resources).
- **SSO / SAML / OIDC.** dAvePi ships JWT + refresh + password reset. SSO is a build-your-own path.

## Things to plan for

- **Field uniqueness across tenants.** dAvePi's tenant column is `userId`, stamped server-side from the JWT. **Don't use `unique: true` for tenant-scoped uniqueness** — it creates a global index that crosses tenants. Use `compositeIndex: [{ userId: 1, slug: 1 }, { unique: true }]` at the schema level. The per-source guides flag this where it matters.
- **`accountId` for orgs.** If your source models orgs as a column alongside the owner, declare `accountId` on the schema — dAvePi stamps that server-side too. Don't name custom FKs `accountId`; pick `orgId` / `parentAccountId` / similar.
- **Soft delete vs. hard delete.** dAvePi soft-deletes by default (`deletedAt` flag + `restore_*` MCP tool). If the source hard-deleted rows, the migrated rows will land soft-deletable; the behaviour change is usually welcome, but flag it for the team.
- **Audit log retention.** The framework writes an audit row on every mutation and **does not auto-purge** them. Plan a manual `db.audit.deleteMany({ at: { $lt: ... } })` cron if you want bounded growth. The per-source guides reference this where the source did auto-purge.

## What you get on the other side

Once the schema files are in place, you have — automatically:

- REST endpoints (`GET / POST / PUT / DELETE` per resource).
- A GraphQL surface (queries, mutations, type definitions, `__include`-style relation expansion).
- MCP tools per resource (`list_<path>`, `create_<path>`, `update_<path>`, …) for agent integration.
- A typed TypeScript client (`davepi gen-client`).
- A Refine-based admin SPA.
- A `_describe` manifest enumerating every resource, field, and capability.

No application-layer wiring per surface. The schema is the source.

## Per-source guides

- [From Supabase](/migrate-from/supabase/) — Postgres + RLS + Auth + Storage. The most detailed guide, used as the reference end-to-end walkthrough.
- [From Hasura](/migrate-from/hasura/) — tracked Postgres + permission rules + event triggers + Actions.
- [From PocketBase](/migrate-from/pocketbase/) — single-binary collections + API rules + WebSocket subscriptions.
- [From Strapi](/migrate-from/strapi/) — content types + draft/publish + plugins.
- [From Directus](/migrate-from/directus/) — introspected SQL + role policies + Flows.

## See also

- [Comparisons](/compared-to/) — when each source is the right choice and when dAvePi is.
- [Schema file shape](/reference/schema/) — the target shape your migrated data lands in.
- [Quickstart](/quickstart/) — get dAvePi running locally before you start the ETL.
