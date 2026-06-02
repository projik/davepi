---
title: dAvePi vs. Refine
description: Refine is a React-based frontend admin framework, not a backend. dAvePi is a backend that ships its own schema-driven admin (davepi-ui) — a Refine-alternative built on shadcn primitives. They aren't direct competitors; the comparison is "if you reach for Refine to get a CRUD admin, davepi + davepi-ui covers the same ground from the schema."
---

Refine is a React frontend framework for building admin panels, dashboards, and internal tools. You bring your own backend (REST, GraphQL, Supabase, Strapi, Hasura, NestJS, Appwrite, etc.), and Refine's data providers abstract the differences. The killer feature is "100x less boilerplate for CRUD UIs" — Refine generates list / show / edit / create views from your resource definitions, hooks them up to data, and handles auth, routing, notifications, and i18n out of the box.

The comparison is unusual: **Refine doesn't compete with dAvePi — they sit on different layers.** dAvePi is a backend; Refine is a frontend admin builder. But dAvePi *also* ships its own admin, [davepi-ui](https://github.com/projik/davepi-ui), which solves the same "give me an admin UI" problem Refine does. Reach for one or the other; the davepi backend works behind either.

This page exists for evaluators looking at both names and trying to figure out which problem each solves.

## At a glance

The matrix axes here deliberately diverge from the other comparison pages. Refine and dAvePi don't share a feature surface — a row like "REST" or "GraphQL" applies to one side and is nonsense on the other. The shape below is the orientation table instead: what each tool *is*, so the differentiation is clear before the rest of the page.

| Aspect | dAvePi (+ davepi-ui) | Refine |
|--------|----------------------|--------|
| What it is | Backend framework + bundled shadcn admin | Frontend framework (React admin builder) |
| What it generates | REST + GraphQL + MCP + typed client + admin pages | List / show / edit / create / dashboard React views |
| Where it runs | Node server + sibling Vite app | Browser (React) |
| Data source | Owns the DB (MongoDB) | Connects to any backend via data providers |
| Schema location | JS files on the backend | TS resource definitions in the frontend |
| Auth | JWT + refresh on the backend | Auth provider abstraction; works with any auth backend |
| Hosting | Node host + static admin host | Bring your own (static hosting) |
| Replaces | Hand-written backend + hand-written admin | Hand-written admin UI code |

## How davepi-ui differs from Refine

davepi-ui was authored after using Refine in production and hitting three recurring frustrations:

1. **Raw DB field names as labels.** Refine renders `firstName` instead of "First Name" unless you wire the label per resource.
2. **Relations as UUID inputs.** A `belongsTo` field becomes a text input expecting an ObjectId paste — not a searchable combobox.
3. **No inline child creation.** Looking at an account, you can't create a contact for it without leaving the page.

davepi-ui fixes all three from a single source of truth — davepi's `/_describe` manifest — with no per-resource override config. Field labels are title-cased automatically, references render as searchable comboboxes (`<RelationPicker>`) with inline create, and a parent's detail page auto-discovers child tabs from `belongsTo` declarations on sibling schemas (the backend synthesises the inverse `hasMany` so the UI doesn't have to).

It's built on shadcn primitives + Tailwind (not Ant Design), TanStack Query for the data layer, and react-hook-form + zod for forms. The widget library is configurable per-resource via plain TypeScript override files (`src/resources/<path>.ts`), and the whole UI is composable from JSON page descriptors so an AI agent can emit pages programmatically through the `@davepi/ui-mcp` server.

## What you're really choosing between

| You want to… | Pick |
|--------------|------|
| Build a backend (API server, schemas, business logic) | dAvePi |
| Build a frontend admin UI for an existing backend | Refine |
| Both: backend + admin from one source of truth | dAvePi + davepi-ui (bundled by `create-davepi-app`) |
| Custom admin UI against a dAvePi backend | Refine pointed at davepi's typed client |
| Custom admin UI against a non-dAvePi backend | Refine |

## Where davepi-ui wins (over a hand-built Refine app)

- **Zero per-resource config.** `/_describe` IS the resource definition. New schemas appear in the sidebar on refresh — no Refine resource registration, no provider tweaks.
- **Relations work out of the box.** `<RelationPicker>` (searchable combobox), `<RelatedList>` (embedded child table on parent detail), `<RelatedCreateModal>` (inline create stamped with parent FK). All discovered through the schema, no per-resource code.
- **Stays in lockstep with the schema.** Add a field, hot-reload, the form has the new input on next refresh. Add a `belongsTo`, the parent detail gets a new child tab automatically.
- **ACL projection.** The admin reads the framework's ACL slots and hides / disables fields per logged-in user role.
- **State-machine action buttons.** Reads `availableTransitions` from each record and renders the right buttons. Hand-built Refine apps wire this per state.
- **Agent-composable.** JSON page descriptors + an MCP server let Claude Code emit pages programmatically.

## Where a hand-built Refine app wins (over davepi-ui)

- **Custom layouts.** Kanban boards, calendar views, multi-step wizards, dashboards with bespoke charts — davepi-ui ships a list/detail/form vocabulary plus an inline JSX escape hatch, but it's not the right shape if every screen is custom.
- **Different backend.** If your data lives outside dAvePi (a SQL DB, a third-party API, multiple sources federated), Refine against several data providers is the right shape.
- **Pixel-level branding.** davepi-ui ships shadcn defaults plus theme-token overrides — fine for most internal tools, not the right tool for a marketing-grade admin.
- **Locked schema.** If you don't want the form changing when someone edits a schema file, hand-roll the form.

## Pick dAvePi (+ davepi-ui) if…

- You need a backend AND want an auto-rendered admin from the same source of truth.
- The admin's job is "list, filter, edit, drill into relations" on rows the schemas already describe.
- You'd rather not maintain a separate Refine codebase that drifts as schemas change.

## Pick Refine if…

- You already have a backend (or are building one with another tool) and just need a great admin UI for it.
- The admin requires custom layouts, complex dashboards, or pixel-level design.
- You're maintaining a frontend codebase anyway and want one framework across product + admin.

## "Use both" still works

The hybrid pattern is still viable: dAvePi for the backend, Refine for a custom admin pointed at it. The auto-generated typed client (`npx davepi gen-client`) plugs into Refine's data provider abstraction. davepi-ui doesn't get in the way — skip the auto-scaffold with `npx create-davepi-app my-app --no-admin` and point your Refine project at the davepi API directly.

## Migration sketch

Refine doesn't compete with dAvePi, so there's no "migrate FROM Refine TO dAvePi" path. The adjacent migration is **switching a Refine app's backend (data provider) to dAvePi** — common when the team has an existing Refine admin pointed at Supabase / Strapi / a hand-written REST API and wants to consolidate on dAvePi as the backend. High-level steps:

1. **Spin up dAvePi** with the schemas the Refine app needs (see [Quickstart](/quickstart/)). One JS file per resource; keep field names in sync with the Refine resource definitions to minimise frontend churn.
2. **Generate the typed client.** `npx davepi gen-client --out src/api/davepi.ts` in the Refine project. Pair with [`client/davepi-runtime.ts`](/surfaces/client/).
3. **Swap the data provider.** Replace the existing `dataProvider` in your Refine `<Refine>` config with one that wraps dAvePi's typed client. Refine's data provider interface is small (`getList`, `getOne`, `create`, `update`, `deleteOne`, etc.) — each method becomes a call into `api.<resource>.<method>`.
4. **Auth provider.** Swap the Refine `authProvider` for one that hits dAvePi's `/login` and stores the JWT.
5. **ETL the data.** Source-specific — typical pattern is a one-off script that reads from the old backend and POSTs to dAvePi's REST surface (use `Idempotency-Key` so reruns are safe).
6. **Drop the old data provider once cutover is complete.**

The reverse direction — dAvePi backend + Refine admin instead of davepi-ui — also works. Scaffold with `--no-admin`, start a fresh Refine project against the typed client's output, build the resources you want.

## See also

- [davepi-ui](https://github.com/projik/davepi-ui) — the schema-driven shadcn admin dAvePi ships.
- [TypeScript client](/surfaces/client/) — what frontend code (Refine, davepi-ui, or otherwise) calls to talk to dAvePi.
- [Other comparisons](/compared-to/) — these are about competing backends; this page is about a complementary tool.
