# Changelog

All notable changes to **dAvePi** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from v1.0.0 onward (see [Stability commitments](https://docs.davepi.dev/reference/stability/)).

## [Unreleased]

### Added

- **Prometheus `/_metrics` endpoint.** Opt-in via `METRICS_ENABLED=true`. Exposes default Node.js metrics plus `http_requests_total` (counter) and `http_request_duration_seconds` (histogram), labelled by `method`, `route` (matched Express path template, not raw URL), and `status_code`. Optional Bearer-token gating via `METRICS_TOKEN`. The middleware short-circuits when disabled, so the only cost when off is one env-var check per request. (#67)
- **Observability docs.** New page at `/operations/observability/` covering OpenTelemetry, Sentry, Datadog APM, and the built-in Prometheus endpoint. Starter Grafana + Datadog dashboards under `docs/site/public/dashboards/`. (#67)
- **`@davepi/mcp` npm package.** One-line agent wiring for Claude Desktop / Cursor / Claude Code. Two modes picked by env: HTTP-proxy (`DAVEPI_URL` + `DAVEPI_TOKEN`) bridges stdio JSON-RPC to a remote `/mcp` HTTP endpoint, including SSE response decoding; local-stdio (`DAVEPI_SCHEMAS` or default) spawns `davepi mcp` from the project's local install and pipes stdio. Zero runtime dependencies. CI smoke-tests on every PR; publish workflow gated on `@davepi/mcp@<version>` tag. The scaffolder's `.mcp.json` now uses `@davepi/mcp` so new projects work without manual binary-path management. (#63)

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
