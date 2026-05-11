---
title: dAvePi vs. the alternatives
description: Honest comparisons against Supabase, Hasura, PocketBase, Strapi, Directus, and Refine. Includes a feature matrix, "pick X if…" decision frameworks, and where dAvePi is the wrong choice.
---

dAvePi sits in a crowded space: "schema-in, API-out" backends.
Evaluators write the comparison in their head whether or not we
publish one — better to frame the conversation honestly.

Each page below uses the same shape:

- **At a glance** — feature matrix.
- **What's similar** — the shared ground.
- **Where dAvePi wins** — concrete advantages.
- **Where the alternative wins** — concrete advantages going the other way.
- **Pick X if… / Pick dAvePi if…** — decision framework.
- **Migration sketch** — high-level path between them.

The framing is "pick the right tool for the job," not "dAvePi wins
every row." If a comparison page reads like marketing, it's failing
its purpose.

## Pages

- [vs. Supabase](/compared-to/supabase/) — the closest direct competitor. Postgres-based BaaS with auth/storage/realtime.
- [vs. Hasura](/compared-to/hasura/) — GraphQL-first on Postgres + other SQL backends.
- [vs. PocketBase](/compared-to/pocketbase/) — single-binary Go + SQLite. Minimalist.
- [vs. Strapi](/compared-to/strapi/) — Node headless CMS with a strong admin-UI focus.
- [vs. Directus](/compared-to/directus/) — Node, database-agnostic, sits on top of an existing SQL DB.
- [vs. Refine](/compared-to/refine/) — Different positioning: Refine is a frontend admin framework that pairs *with* a backend. dAvePi *is* a backend (and ships a Refine-based admin).

## The framework's own honest gaps

Common to every comparison, called out so they're not buried in
per-page text:

- **MongoDB only.** Not a fit if your team's expertise or
  ecosystem is SQL-shaped.
- **Pre-1.0 maturity.** v1.0.0 is recent. Big-org adopters who
  want a year of production deployments behind them might wait.
- **No bundled hosted offering.** You bring your own host (Fly /
  Render / AWS / your own metal). Several alternatives below have
  a managed-hosted path; dAvePi doesn't today.
- **Smaller ecosystem.** Plugins / templates / community-built
  pieces count in dozens, not thousands. The framework's
  schema-driven design intentionally absorbs many "plugin"
  use-cases as core features, which trades plugin count for less
  glue code — but if you want a 5000-plugin marketplace, that's
  a different tool.

These appear on every page; the per-comparison pages add the
alternative's specific strengths on top.
