---
title: Stability commitments
description: What dAvePi promises about backwards compatibility — semver, the deprecation window, and which APIs are stable / experimental / internal.
---

dAvePi follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from v1.0.0 onward. This page enumerates which APIs are covered by
that promise and what to expect when something changes.

## What versions mean

| Bump | Means |
|------|-------|
| **Major** (`1.x.x` → `2.0.0`) | Breaking change to a stable API. |
| **Minor** (`1.0.x` → `1.1.0`) | Backwards-compatible new feature on a stable API. |
| **Patch** (`1.0.0` → `1.0.1`) | Backwards-compatible bug fix or security patch. |

If you pin to `^1.0.0`, you'll get every minor and patch — and a
working application — until you decide to upgrade across a major
boundary.

## What's stable (covered by semver)

These surfaces are **stable**: a breaking change requires a major
version bump, and the previous behaviour stays available through
at least one full minor under deprecation.

- **Schema vocabulary.** Every key inside a schema file's top-level
  object (`path`, `collection`, `fields`, `relations`,
  `aggregations`, `compositeIndex`, `softDelete`, `audit`, `acl`,
  `webhooks`, `retention`) and every key inside a `fields[]` entry
  (see [Field options](/reference/fields/)).
- **REST surface.** Auto-generated routes per schema, request /
  response shapes, query parameter conventions
  (`__page`, `__sort`, `__perPage`, `__include`,
  `__includeDeleted`, mongo-querystring filters, `q`).
- **GraphQL surface.** Resolver naming
  (`<path>Many`, `<path>ById`, `<path>UpdateById`,
  `<path>Transition<Field>`, etc.), input type shapes
  (`<Path>Input`, `<Path>UpdateInput`, `<Path>FilterInput`).
- **MCP tool surface.** Tool naming
  (`list_<path>`, `create_<path>`, `update_<path>`,
  `delete_<path>`, `aggregate_<path>_<name>`,
  `list_<path>_<rel>`, `upload_<path>_<file>`, etc.) and tool
  argument schemas.
- **Error envelope.** `{ error: { code, message, details? } }` shape
  and the typed-error catalogue at [Errors](/reference/errors/).
  The `code` field is part of the contract; the `message` is human-
  readable and may change without a major bump.
- **`_describe` manifest.** Top-level `version`, `schemas`, `auth`,
  `features` keys and the per-schema metadata shape. Additive
  changes are minor; removed fields require a major.
- **CLI commands.** `davepi gen-client`, `davepi migrate up/down/status`,
  `davepi mcp` flags and exit-code semantics.
- **Idempotency contract.** `Idempotency-Key` header, body-hash
  scoping, claim-execute-complete protocol, TTL behaviour.
- **Auth / token shape.** `/login` and `/register` request /
  response bodies, JWT claim names (`user_id`, `email`, `roles`).

## What's experimental

Marked clearly when introduced; behaviour or shape can change in a
minor release with a deprecation note in the CHANGELOG.

- New schema options shipped behind a feature flag.
- Aggregation `unsafe: true` semantics — currently stable but the
  set of `acl` slots that grant access may evolve.
- Admin SPA layout / theme / preview features (the data flow is
  stable; the UI is not).

When in doubt, check the docs page for that feature — the page
will say "experimental" if it isn't covered by semver yet.

## What's internal (not covered)

Changes to these can ship in any release without a deprecation
window. Don't depend on them:

- **`utils/*` private helpers.** `schemaLoader`, `scopeResolver`,
  `mcpServer`, etc. are framework internals. The features they
  expose through the public surfaces are stable; the helpers
  themselves are not.
- **Mongo storage layout.** Collection names, document shapes,
  index choices — these are implementation details. Use REST /
  GraphQL / MCP, not direct queries.
- **Log line formats.** Pino field names and severities can change.
  Don't grep production logs for specific phrases as a
  monitoring hook — use structured queries on the JSON.
- **Bundled admin SPA bundle hashes / file paths.** If you embed it
  somewhere, point at the published path; don't deep-link into
  `node_modules`.

## Deprecation policy

When a stable API is going to change in a future major:

1. **Mark it deprecated** in a minor release. The runtime emits a
   warning (a `Deprecation` HTTP header on the response, a
   `console.warn` from the CLI, an `extensions.deprecated` flag
   on GraphQL responses), the `_describe` manifest carries
   `deprecated: true`, and the CHANGELOG calls it out.
2. **Keep the old behaviour working** for at least one full minor
   release — usually longer.
3. **Remove it** in the next major. The CHANGELOG explicitly
   lists every removal.

Migrating between majors should never be a surprise: by the time a
major drops, every removal has been deprecated for at least one
release line and documented.

## What "stable" doesn't mean

- **Bug fixes can change behaviour.** A patch that makes
  `INVALID_TRANSITION` carry the right `allowed` array isn't a
  breaking change, even though code that relied on the buggy
  empty-array might break. We try to call out behaviour changes in
  the CHANGELOG anyway.
- **Performance can change.** A response that took 50ms might take
  30ms or 80ms across versions. Latency isn't part of the contract;
  correctness is.
- **Internal logging can change.** Adding a field to the log JSON
  is not a breaking change.
- **Output ordering for unsorted lists.** If you don't pass
  `__sort`, document order isn't guaranteed across versions.

## Reporting a contract regression

If a minor or patch release breaks one of the stable APIs above,
that's a bug — open an issue on
[GitHub](https://github.com/projik/davepi/issues) and we'll treat
it as a regression to fix in the next patch.

## See also

- [CHANGELOG](https://github.com/projik/davepi/blob/main/CHANGELOG.md) — every release's changes.
- [SECURITY](https://github.com/projik/davepi/blob/main/SECURITY.md) — disclosure process and supported versions for security fixes.
- [Errors](/reference/errors/) — the typed error catalogue (stable codes).
