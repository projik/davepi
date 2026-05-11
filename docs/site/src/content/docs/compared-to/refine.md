---
title: dAvePi vs. Refine
description: Refine is a React-based frontend admin framework, not a backend. The comparison is "Refine pairs WITH a backend; dAvePi IS a backend." They aren't competitors — they're complementary, and dAvePi ships a Refine-based admin out of the box.
---

Refine is a React frontend framework for building admin panels,
dashboards, and internal tools. You bring your own backend (REST,
GraphQL, Supabase, Strapi, Hasura, NestJS, Appwrite, etc.), and
Refine's data providers abstract the differences. The killer
feature is "100x less boilerplate for CRUD UIs" — Refine
generates list / show / edit / create views from your resource
definitions, hooks them up to data, and handles auth, routing,
notifications, and i18n out of the box.

The comparison is therefore unusual: **Refine doesn't compete
with dAvePi — it pairs with it.** dAvePi's admin SPA is literally
a Refine app that reads the `_describe` manifest at startup and
renders forms / tables / detail views per schema.

This page exists for evaluators looking at both names and trying
to figure out which problem each solves.

## At a glance

The matrix axes here deliberately diverge from the other
comparison pages. Refine and dAvePi don't share a feature surface
— a row like "REST" or "GraphQL" applies to one side and is
nonsense on the other. The shape below is the orientation table
instead: what each tool *is*, so the differentiation is clear
before the rest of the page.

| Aspect | dAvePi | Refine |
|--------|--------|--------|
| What it is | Backend framework (API server) | Frontend framework (React admin builder) |
| What it generates | REST + GraphQL + MCP + typed client + admin SPA | List / show / edit / create / dashboard React views |
| Where it runs | Node server | Browser (React) |
| Data source | Owns the DB (MongoDB) | Connects to any backend via data providers |
| Schema location | JS files on the backend | TS resource definitions in the frontend |
| Auth | JWT + refresh on the backend | Auth provider abstraction; works with any auth backend |
| Hosting | Bring your own (Node host) | Bring your own (static hosting) |
| Replaces | Hand-written backend + auto-generated admin | Hand-written admin UI code |

## How they relate

The dAvePi admin SPA ships as a Refine app at
`<davepi>/admin/`. On startup it fetches `GET /_describe` and uses
the manifest to register Refine resources, with the
fields / relations / state machines automatically driving the
right form widgets, list columns, and detail panes. So if you've
worked with Refine and like it, the dAvePi admin is the same
framework, configured by the framework's discovery manifest
instead of by hand.

Conversely, if you've built a Refine app against another
backend, you could swap the data provider to dAvePi's typed
client without changing the resource definitions in the frontend.

## What you're really choosing between

| You want to… | Pick |
|--------------|------|
| Build a backend (API server, schemas, business logic) | dAvePi |
| Build a frontend admin UI for an existing backend | Refine |
| Both: backend + admin from one source of truth | dAvePi (ships a Refine-based admin) |
| Custom admin UI against a non-dAvePi backend | Refine |

## Where dAvePi's bundled admin wins (compared to a hand-built Refine app)

- **Zero per-resource config.** The framework's `_describe`
  manifest is the resource definition. You don't write Refine
  resources by hand for each schema — they appear automatically.
- **State-machine action buttons.** The admin reads
  `availableTransitions` from each record and renders the right
  buttons. Hand-built Refine apps need to wire this per state.
- **ACL projection.** The admin reads the framework's ACL slots
  and hides / shows fields per logged-in user role automatically.
- **Stays in lockstep.** Add a field to a schema, hot-reload, the
  admin's form has the new input on next refresh.

## Where a hand-built Refine app wins (over dAvePi's bundled admin)

- **Custom layouts.** If you need a specific dashboard, kanban
  board, calendar view, or non-CRUD UX, dAvePi's bundled admin
  doesn't know about your custom shape — you'd build that as a
  separate Refine app. Refine's strength is "any UI you can
  imagine for managing data."
- **Different backend.** If your data lives somewhere dAvePi
  doesn't (a SQL DB, a third-party API, multiple sources
  federated), a hand-built Refine app against multiple data
  providers is the right shape.
- **Branding / theming.** dAvePi's admin is functional and clean
  but isn't customisable to product-marketing levels. Refine
  can do whatever your design team draws.
- **Locked schema.** If the schema is fixed and you don't want
  the admin form changing when someone edits a schema file,
  a hand-built Refine app pins the structure.

## Pick dAvePi if…

- You need a backend AND want an auto-rendered admin from the
  same source of truth.
- You're early enough that "the framework's admin shape works"
  is fine.
- You'd rather not maintain a separate frontend codebase for the
  admin.

## Pick Refine if…

- You already have a backend (or are building one with another
  tool) and just need a great admin UI for it.
- The admin requires custom layouts, complex dashboards, or
  pixel-level design.
- You're maintaining a frontend codebase anyway and want one
  framework across product + admin.

## "Use both" is the common case

The mainstream pattern: dAvePi for the backend, Refine for the
frontend admin (using either dAvePi's bundled admin as-is, or a
custom Refine app pointing at dAvePi's API). The auto-generated
typed client (`davepi gen-client`) plugs into Refine's data
provider abstraction; resource definitions match the schema
shape; auth, routing, and notifications work the same way they
do against any other backend.

If you find the bundled admin doesn't fit, the upgrade path is
to fork or replace it with a standalone Refine app — same
framework, more control.

## Migration sketch

Refine doesn't compete with dAvePi, so there's no
"migrate FROM Refine TO dAvePi" path. The adjacent migration is
**switching a Refine app's backend (data provider) to dAvePi** —
common when the team has an existing Refine admin pointed at
Supabase / Strapi / a hand-written REST API and wants to consolidate
on dAvePi as the backend. High-level steps:

1. **Spin up dAvePi** with the schemas the Refine app needs
   (see [Quickstart](/quickstart/)). One JS file per resource;
   keep field names in sync with the Refine resource definitions
   to minimise frontend churn.
2. **Generate the typed client.** `npx davepi gen-client --out
   src/api/davepi.ts` in the Refine project. Pair with
   [`client/davepi-runtime.ts`](/surfaces/client/).
3. **Swap the data provider.** Replace the existing
   `dataProvider` in your Refine `<Refine>` config with one that
   wraps dAvePi's typed client. Refine's data provider
   interface is small (`getList`, `getOne`, `create`, `update`,
   `deleteOne`, etc.) — each method becomes a call into
   `api.<resource>.<method>`. Several community data providers
   for REST shapes can be adapted to dAvePi's
   mongo-querystring filter convention with minimal changes.
4. **Auth provider.** Swap the Refine `authProvider` for one that
   hits dAvePi's `/login` and stores the JWT. The provider's
   `getIdentity` reads `req.user` from a `/me`-style endpoint or
   decodes the token client-side.
5. **ETL the data.** Source-specific — typical pattern is a one-off
   script that reads from the old backend and POSTs to dAvePi's
   REST surface (use `Idempotency-Key` so reruns are safe).
6. **Drop the old data provider once cutover is complete.**

If you're going the other direction — dAvePi backend, but the
bundled Refine-based admin SPA doesn't fit and you want a custom
Refine app — fork the bundled admin or start a fresh Refine
project against `davepi gen-client`'s output. Same framework,
custom shape.

## See also

- [Admin SPA](https://docs.davepi.dev/surfaces/describe/) — how
  the bundled admin reads `_describe`.
- [TypeScript client](/surfaces/client/) — what frontend code
  (Refine or otherwise) calls to talk to dAvePi.
- [Other comparisons](/compared-to/) — these are about competing
  backends; this page is about a complementary tool.
