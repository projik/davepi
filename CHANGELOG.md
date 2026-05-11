# Changelog

All notable changes to **dAvePi** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from v1.0.0 onward (see [Stability commitments](https://docs.davepi.dev/reference/stability/)).

## [Unreleased]

### Added

- **`create-davepi-app` publish workflow.** New `.github/workflows/create-davepi-app-publish.yml` that publishes the scaffolder to npm on a `create-davepi-app@<version>` tag push. Same shape as the `@davepi/mcp` publish workflow — gated behind the `npm-publish` GitHub Environment (so a reviewer approves each release) with a tag-vs-package-version mismatch check, but uses a classic `NPM_TOKEN` granular access token rather than OIDC Trusted Publishing (the npm account doesn't yet expose the trusted-publisher path). The package's existing `prepublishOnly` hook (`node bin/sync-templates.js`) runs automatically as part of `npm publish`. The first tag push unblocks the `npx create-davepi-app` flow that the quickstart guide assumes.
- **Migration guides.** Five new pages under `/migrate-from/` covering Supabase, Hasura, PocketBase, Strapi, and Directus. Each follows the same shape: schema-mapping table (source field types → dAvePi field types), permissions / ACL translation, relationships → `relations` map, ETL script template (per-batch `Model.collection.insertMany` with a `legacyId` column for FK rewrites), auth migration walkthrough (force-reset emails via `/auth/forgot-password`; password-hash carry-over where Strapi's bcrypt rounds match dAvePi's), file-storage move (S3 sync / rsync + `FileMeta` sub-document stamping), and a cutover checklist. The Supabase guide is the reference end-to-end walkthrough — worked example of a deal-tracker app, read-cutover-then-write pattern, two-pass FK rewrite. Each comparison page now ends with a link to the corresponding full guide. New "Migrate from" sidebar group sits below "Compared to". (#72)
- **Backup & restore guide.** `/operations/backup/` restructured into a hub with six new sub-pages: per-platform configuration (self-host with `mongodump` cron, MongoDB Atlas continuous backup with PITR, AWS DocumentDB automated snapshots + manual + cross-region copy, Azure Cosmos DB Periodic vs Continuous), file-storage backup strategies (`local` with restic/rsync, `s3` with versioning + replication, `gcs` with multi-region buckets), and the restore drill checklist (step-by-step quarterly rehearsal procedure with explicit failure-mode triage). Adds RPO/RTO framing to the overview and a FileMeta-↔-blob consistency check that catches mismatched DB/storage snapshot timing. Linked from the per-platform [deployment guides](/operations/deployment/) so the "what about backups?" question always lands on a real answer. (#71)
- **Per-platform deployment guides.** Seven new pages under `/operations/deployment/`: self-host (Docker Compose + Caddy), Railway, Render, Fly.io, AWS (ECS Fargate + DocumentDB), GCP (Cloud Run + MongoDB Atlas), and Azure (Container Apps + Cosmos DB Mongo API). Each follows the same shape — quick reference, architecture, deploy steps, custom domain + TLS, backup strategy, scaling notes, observability — so an evaluator can scan across them. New `deploy/docker-compose.prod.yml` + `deploy/Caddyfile` + `deploy/.env.example` ship a working production stack for the self-host case. Existing deployment page restructured into a hub with a per-platform comparison table. (#66)
- **Comparison pages.** Six new docs pages under `/compared-to/` covering Supabase, Hasura, PocketBase, Strapi, Directus, and Refine. Each follows the same shape: feature matrix, what's similar, where dAvePi wins, where the alternative wins, "pick X if… / pick dAvePi if…" decision framework, and a migration sketch. Honest about gaps — every page calls out where dAvePi is the wrong choice. Indexed at `/compared-to/` with a shared "honest gaps" list (Mongo-only, pre-1.0, no hosted offering, smaller ecosystem). New "Compared to" sidebar section between Operations and the bottom of the IA. (#62)
- **Community plumbing.** `CONTRIBUTING.md` covering dev setup, code style, the PR review process, and CHANGELOG expectations. `CODE_OF_CONDUCT.md` adopting Contributor Covenant 2.1 (with `conduct@davepi.dev` as the report inbox). `MAINTAINERS.md` listing reviewers and area ownership. Structured issue templates (`.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`) with dropdowns for the affected surfaces; `config.yml` deflects "how do I do X" to Discussions Q&A and disables blank issues. `.github/PULL_REQUEST_TEMPLATE.md` for the standard summary / why / test-plan / checklist shape. New "Community" line in the README links the lot. (#70)
- **Prometheus `/_metrics` endpoint.** Opt-in via `METRICS_ENABLED=true`. Exposes default Node.js metrics plus `http_requests_total` (counter) and `http_request_duration_seconds` (histogram), labelled by `method`, `route` (matched Express path template, not raw URL), and `status_code`. Optional Bearer-token gating via `METRICS_TOKEN`. The middleware short-circuits when disabled, so the only cost when off is one env-var check per request. (#67)
- **Observability docs.** New page at `/operations/observability/` covering OpenTelemetry, Sentry, Datadog APM, and the built-in Prometheus endpoint. Starter Grafana + Datadog dashboards under `docs/site/public/dashboards/`. (#67)
- **`@davepi/mcp` npm package.** One-line agent wiring for Claude Desktop / Cursor / Claude Code. Two modes picked by env: HTTP-proxy (`DAVEPI_URL` + `DAVEPI_TOKEN`) bridges stdio JSON-RPC to a remote `/mcp` HTTP endpoint, including SSE response decoding; local-stdio (`DAVEPI_SCHEMAS` or default) spawns `davepi mcp` from the project's local install and pipes stdio. Zero runtime dependencies. CI smoke-tests on every PR; publish workflow gated on `@davepi/mcp@<version>` tag. The scaffolder's `.mcp.json` now uses `@davepi/mcp` so new projects work without manual binary-path management. (#63)
- **CI workflow templates for scaffolded projects.** Every `npx create-davepi-app` project now ships `.github/workflows/{test,client-gen,migrate,deploy}.yml` plus a `tests/smoke.test.js` schema-shape validator and a `test` npm script. `test.yml` matrix-tests across Node 20.x + 22.x with a Mongo service container; `client-gen.yml` guards against typed-client drift on PRs; `migrate.yml` enforces a two-stage dry-run + reviewer-approval gate via a `migrate-prod` GitHub Environment; `deploy.yml` targets Fly.io by default with alternates documented in-file. Configuration covered in `/operations/deployment/`. (#68)
- **Agent eval suite.** New `eval/` harness drives Claude through 10 prompts of escalating complexity against a scratch dAvePi project, scoring each with a programmatic check. Covers fields, state machines, relations, computed, aggregations, ACLs (document + field), file fields, and full-text search. Cumulative state setup — each prompt starts from a deterministic outcome of the prompts before it. Self-tests prove apply/check consistency without an API key (every "perfect agent" run passes); nightly workflow runs the real Anthropic API path and commits `results/latest.json` + `results/badge.json` back to main. README carries a shields.io badge fed by the latter; concept page at `/concepts/agent-eval/` documents the design. (#65)

## [1.0.0] - 2026-05-10

First stable release. The schema vocabulary, REST/GraphQL/MCP
surfaces, error codes, and the `_describe` shape are now covered
by [semver](https://docs.davepi.dev/reference/stability/).

### Added

- **Schema-driven generation.** One file under `schema/versions/v1/`
  becomes a Mongoose model, REST routes, GraphQL types and resolvers,
  Swagger fragments, MCP tools, an admin SPA resource, and an entry
  in the typed-client output.
- **Tenant isolation.** `userId` (and optionally `accountId`) are
  stamped from the JWT on every write and filtered on every read.
  Non-bypassable across REST, GraphQL, MCP, aggregations, and
  relations. (#21–#52)
- **Idempotency keys.** Stripe-style `Idempotency-Key` header on
  every auto-generated `POST` and `idempotencyKey` argument on
  every `create_<path>` MCP tool. Atomic claim-execute-complete
  protocol with stable body hashing. (#49)
- **MCP server.** First-class tool surface at `POST /mcp` (HTTP)
  and `davepi mcp` (stdio). Per-schema `list_*`, `get_*`,
  `create_*`, `update_*`, `delete_*`, plus restore / history /
  search / aggregations / file lifecycle and per-relation
  navigation. (#48)
- **Capability manifest at `/_describe`.** Compact JSON describing
  every loaded schema, field, relation, aggregation, state machine,
  and surface — agent-friendly discovery in one round-trip. (#47)
- **Relations engine.** Declarative `belongsTo` / `hasOne` /
  `hasMany` accessed via `__include`, with batched queries and
  per-traversal tenant scope. (#40)
- **Aggregations.** Declarative `aggregations[]` with auto-injected
  `$match: { userId }` plus REST + GraphQL + MCP + typed-client
  surfaces. (#39)
- **Computed fields.** Read-only fields derived at response time;
  stripped from input shapes everywhere. (#50)
- **State machines.** Per-field `stateMachine` config with
  declared transitions, `onEnter` hooks, `availableTransitions`
  virtual, generated GraphQL `<path>Transition<Field>` mutation
  with enum-typed `to:` arg, and `INVALID_TRANSITION` errors. (#51)
- **Soft delete + restore + audit log.** Default-on tombstones,
  per-record audit trail with field-level diffs, retention sweeps
  (`tombstoneTtlDays`, `auditTtlDays`). (#36)
- **File fields.** `type: 'File'` with multipart upload, configurable
  `maxBytes` / `accept`, `storage` backends (`local`, `s3`, `gcs`),
  public or signed-URL visibility. (#34)
- **Full-text search.** Mark fields `searchable: true` to opt into
  the framework-managed text index, `?q=` parameter, and
  `search_<path>` MCP tool. (#35)
- **Role-based ACL.** Document-level `acl.list` / `acl.delete`
  bypass slots and field-level `acl.read` / `acl.create` /
  `acl.update`. Symmetric across REST / GraphQL / MCP / audit /
  webhooks. (#32)
- **Outbound webhooks.** HMAC-SHA256-signed deliveries on
  create / update / delete / restore / transition events, with
  exponential-backoff retries and per-attempt audit rows. (#33)
- **Hot reload.** `chokidar`-driven schema watcher rebuilds the
  full surface (REST router, GraphQL via indirection middleware,
  MCP tool list with `tools/list_changed`) in 50–150ms. Gated on
  `NODE_ENV !== 'production' && HOT_RELOAD_SCHEMAS=true`. (#31)
- **Typed TypeScript client.** `npx davepi gen-client` walks the
  schema map and emits a deterministic, fully-typed client per
  resource (relations, state machines, aggregations, file fields,
  errors). (#52)
- **Schema migrations.** `npx davepi migrate up/down/status` with
  resumable cursors and a `_davepi_migrations` table; expand-
  migrate-contract pattern. (#37)
- **Admin SPA.** Refine-based `/admin` reads `_describe` at startup
  and renders forms / tables / detail views per schema with no
  per-resource wiring. (#38)
- **`create-davepi-app` scaffolder + five templates.** `blank`,
  `crm`, `ticketing`, `content`, `b2b-saas`. Each ships with seed
  data, `.env`, `docker-compose.yml`, and `.mcp.json`. (#73)
- **Agent dev guide for downstream projects.** Canonical
  `agent.md` mirrored to `.cursorrules`, `AGENTS.md`, and
  `.claude/skills/davepi/SKILL.md` per scaffolded project. (#75)
- **Public docs site at `docs.davepi.dev`** built with Astro
  Starlight under `docs/site/`. CI auto-deploys on push to `main`. (#74, #76)

### Security

- **Auth.** JWT-based with bcrypt hashing, per-user / per-IP rate
  limiting on `/login` / `/register`. Refresh tokens with
  rotation. (#28, #25)
- **Defaults.** `helmet` (with carve-out for `/api-docs` and
  `/graphql` in dev), CORS allowlist via `CORS_ORIGINS`, log
  redaction for `authorization`, `cookie`, `*.password`, `*.token`. (#25, #24)
- **Production posture.** `NODE_ENV=production` disables
  GraphQL playground, introspection, and verbose error
  messages (unknown errors reduce to `Internal server error`).
- **Tenant-scoped uniqueness.** Composite indexes lead with
  `userId` so `unique: true` constraints don't cross tenants.

### Documentation

- **Stability commitments** (`docs/reference/stability/`) — semver,
  deprecation window, and the catalogue of stable / experimental /
  internal APIs.
- **`SECURITY.md`** — disclosure process, supported version lines,
  scope, response timeline.
- **`CHANGELOG.md`** — this file. Going forward, every PR that ships
  a user-visible change adds an entry under `[Unreleased]`; a CI
  guard fails PRs that don't update the changelog (with a
  `skip-changelog` label as the opt-out for chores).

### Notes

- Pre-1.0 `0.x` development happened on `main` without published
  tags. v1.0.0 is the first release covered by the semver +
  deprecation policy.
- The Mongo backend is required and intentional — SQL backends
  are not supported.
- `accountId` is auto-stamped from the JWT alongside `userId`;
  custom foreign keys must be named differently (`parentAccountId`,
  `orgId`, etc.).

[Unreleased]: https://github.com/projik/davepi/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/projik/davepi/releases/tag/v1.0.0
