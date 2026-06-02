# Maintainers

This file is the canonical list of people with merge rights on
`projik/davepi` and the areas they own. Issue triage, PR review,
and final merge decisions are theirs.

## Current maintainers

| Name | GitHub | Areas |
|------|--------|-------|
| David Baxter | [@projik](https://github.com/projik) | Everything — framework core, schema loader, MCP, scaffolder, docs site, eval. |

## Area ownership (forward-looking)

As contributors take on regular review work in a specific area
they get added here. None of the areas below have a dedicated
owner yet — all PRs route through the current maintainer.

| Area | Code lives in | Owner |
|------|---------------|-------|
| Framework core | `app.js`, `index.js`, `middleware/`, `utils/` | @projik |
| Schema-driven generation | `utils/schemaLoader.js`, `utils/scopeResolver.js`, `schema/versions/` | @projik |
| MCP surface | `utils/mcpServer.js`, `packages/mcp/` | @projik |
| Auth + tenancy | `routes/auth/`, `middleware/auth.js`, `model/user.js` | @projik |
| Scaffolder + templates | `create-davepi-app/`, `templates/` | @projik |
| Docs site | `docs/site/` | @projik |
| Agent eval | `eval/` | @projik |
| Typed client | `utils/clientGen.js`, `client/davepi-runtime.ts` | @projik |

## Becoming a maintainer

The framework's contributor base is small enough that maintainer
status is offered, not requested. The path is roughly:

1. **Sustained review work.** A few well-scoped, well-reviewed PRs
   in a specific area over a couple of months — enough that the
   current maintainer trusts your judgement on what should land
   there.
2. **Public discussion.** A current maintainer opens an issue
   proposing the addition. Existing maintainers ack; the
   candidate confirms.
3. **Merge access.** GitHub permissions updated, this file gets
   a new row.

There's no fixed cadence — maintainers get added when the work
warrants it.

## Stepping down

Maintainers who no longer have time / interest should open a PR
that removes their row from this file. No drama; the project
appreciates the work that landed and the honesty about the change
in availability.

## Conflict resolution

Two maintainers disagree on whether a PR should land? The current
maintainer with the most recent area-specific work has the
deciding vote. If that's still unclear (newer area, equal recency),
@projik decides.

## Why this file exists

So contributors know who reviews their PRs, who to ping on a
stalled one, and what "becoming a maintainer" actually looks
like — none of which is obvious from the GitHub UI.
