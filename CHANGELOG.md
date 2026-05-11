# Changelog

All notable changes to **dAvePi** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from v1.0.0 onward (see [Stability commitments](https://docs.davepi.dev/reference/stability/)).

## [Unreleased]

## [1.0.4] - 2026-05-11

### Fixed

- **Admin SPA assets returned `403 CORS_NOT_ALLOWED` for same-origin requests.** Vite emits `<script type="module" crossorigin src="/admin/assets/index-…js">` and `<link rel="stylesheet" crossorigin href="/admin/assets/index-…css">`, and the browser sends an `Origin` header for `crossorigin`-attributed elements **even on same-origin requests**. The default `CORS_ORIGINS=http://localhost:3000` doesn't include the API's own origin, so requests from `/admin/` back to `/admin/assets/*` were rejected with 403 + JSON body — manifesting as `GET .../admin/assets/...js 403 (Forbidden)` and `Refused to apply style from .../admin/assets/...css because its MIME type ('application/json') is not a supported stylesheet MIME type`. Fix: `middleware/corsConfig.js` now detects same-origin (`Origin` matches `Host`) and bypasses the allowlist check, reflecting the request's Origin via a separate `cors({ origin: true })` instance. A cross-site attacker can't spoof this because the browser sets `Host` based on the target URL it's fetching, not the attacker page's origin. New `create-davepi-app@0.1.2` adds `http://localhost:${apiPort}` to the scaffolded `.env`'s `CORS_ORIGINS` as belt-and-suspenders so the admin SPA also works for users on `davepi@1.0.3` who upgrade just the scaffolder. (#99)

## [1.0.3] - 2026-05-11

### Fixed

- **Admin SPA `/admin/*` returned a "SPA not built" 404 even though the bundle was in the published package.** Same class of bug as 1.0.2's schema-require fix: `app.js` resolved `path.resolve('./admin/dist')` against `process.cwd()` (the consumer's project root) instead of `__dirname` (the framework's location inside `node_modules/davepi/`). The pre-built SPA ships **inside** the package at `node_modules/davepi/admin/dist/`, so the existsSync check was looking in the wrong place and `hasAdminBuild` was always false in a consumer install. Fix: `path.resolve(__dirname, 'admin/dist')`. The schema-loading path (`dirTree("./schema/versions")`) and the watcher's `schemasDir` correctly stay cwd-relative — those target the consumer's schemas. (#96)
### Fixed

- **Docs and the scaffolder's post-scaffold message told users to build the admin SPA — which isn't needed.** The published `davepi` package ships a pre-built `admin/dist/` bundle. Dropped the "9:00 — Wire the admin SPA" build steps from the "Idea to deployed CRM in 10 minutes" guide; replaced with a single "open `http://localhost:4001/admin`" line. README's Admin UI section reframed: pre-built for consumers; the `build:admin` / `dev:admin` scripts are documented as for-this-repo-only (developing the SPA itself). PocketBase comparison updated to drop the "extra build step" claim. `create-davepi-app@0.1.1`: scaffolder's "Admin SPA: ..." next-steps line no longer carries the misleading "after `npm run build:admin` in node_modules/davepi" suffix. (#97)

## [1.0.2] - 2026-05-11

### Fixed

- **Scaffolded apps crashed on `npm start` with `Cannot find module './schema/versions/v1/<name>.js'`.** `app.js:140` discovered schema files via `dirTree` (which walks paths relative to `process.cwd()` — the consumer's project root, correct), then called `require("./" + file.path)` to load them. Node resolves `"./..."` requires relative to the **calling file**, which when installed as a dep is `node_modules/davepi/app.js`. So the require looked for `node_modules/davepi/schema/versions/v1/account.js` and crashed. Hidden during framework dev because `process.cwd()` and the framework's own directory are the same. Fix: resolve the schema file path to an absolute path via `path.resolve(file.path)` before `require`-ing — same pattern the next line already used for `__sourceFile` metadata. Hot-reload path was unaffected: `chokidar` emits absolute paths, so `schemaWatcher.requireFresh` was already correct. (#95)

## [1.0.1] - 2026-05-11

### Fixed

- **Scaffolded apps crashed on `npm start` with "unable to determine transport target for pino-pretty".** `utils/logger.js` configures a `pino-pretty` transport whenever `NODE_ENV` isn't `production` or `test`, but `pino-pretty` was in `devDependencies` — so the consumer's `npm install` didn't pull it in and pino bailed at boot. Hidden during framework dev because devDeps are installed locally; surfaced as soon as `davepi@1.0.0` was published and someone ran `npx create-davepi-app demo && cd demo && npm install && npm start`. Fix: move `pino-pretty` to `dependencies`, plus a `require.resolve` guard in `utils/logger.js` so if anything ever strips the package (`npm prune --production`, custom install profile), pino falls back to plain JSON output instead of crashing. Production path is unchanged — `NODE_ENV=production` skips the transport entirely. (#94)
- **`/admin/*` CSP carve-out now holds when the SPA isn't built.** The helmet middleware skips CSP for `/admin/*` so ant-design's inline styles render, but the catch-all route was registered conditionally on `admin/dist/index.html` existing. When the build was missing, requests fell through to Express's `finalhandler`, which injects `Content-Security-Policy: default-src 'none'` on 404s — breaking the carve-out the security suite asserts. Hidden during local dev (the build is usually present) and only surfaced once `davepi-publish.yml` started running `npm test` before `npm run build:admin`. Fix: register the `/admin/*` GET handler unconditionally; serve `index.html` when the build exists, otherwise return a clear 404 ("admin SPA not built. Run `npm run build:admin` after install.") directly without touching `finalhandler`. (#90)

### Added

- **`davepi` package publishable to npm.** Root `package.json` gains a `files: []` allowlist (`index.js`, `app.js`, `bin/`, `config/`, `middleware/`, `model/`, `routes/`, `utils/`, `admin/dist/`, plus `README.md` / `LICENSE` / `CHANGELOG.md`) — without it, npm would publish `test/`, `eval/`, `docs/`, `create-davepi-app/`, `packages/`, `templates/`, `deploy/`, `schema/`, and everything else. Adds `prepublishOnly: "npm run build:admin"` so the admin SPA's `dist/` bundle is materialised into the tarball; without that step, the consumer's `/admin` route 404s. Metadata fixes: real `description`, `keywords[]`, GitHub `repository` / `bugs` / `homepage` (was pointing at bitbucket), `engines.node >= 18`. New `.github/workflows/davepi-publish.yml` mirrors the create-davepi-app workflow shape — tag-triggered on `davepi@<version>`, gated by `npm-publish` environment, runs `npm ci` + `npm test` + `npm run build:admin` + an `npm pack --dry-run` allowlist/forbidden-prefix check before `npm publish`. Locally-verified tarball: 60 files / 671KB packed / 2.1MB unpacked, admin SPA included, no source-tree leaks. Unblocks `npx create-davepi-app` — the scaffolded project's `npm install` was failing because `davepi@latest` was a 404 on the registry.
- **npm publish workflows: `create-davepi-app` + token-based `@davepi/mcp`.** New `.github/workflows/create-davepi-app-publish.yml` publishes the scaffolder on a `create-davepi-app@<version>` tag push. Pre-publish validation runs `node bin/sync-templates.js` (fail-fast before npm wraps it in `prepublishOnly`), a `node bin/index.js --help` CLI smoke, and `npm pack --dry-run --json` asserting that `bin/index.js`, `bin/sync-templates.js`, `README.md`, and at least one `templates/*` entry are in the tarball. Existing `davepi-mcp-publish.yml` swapped from OIDC Trusted Publishing to the same `NPM_TOKEN`-based path (the npm account doesn't yet expose trusted publishers); the `npm test` validation step it already had is preserved. Both workflows gated behind the `npm-publish` GitHub Environment so a reviewer approves each release. The first `create-davepi-app@*` tag push unblocks the `npx create-davepi-app` flow that the quickstart assumes.
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
