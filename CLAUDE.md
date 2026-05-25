# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start            # nodemon index.js (dev, auto-reload)
npm run dev          # same, ignoring swagger/*.json writes
npm test             # jest --runInBand --forceExit
npx jest test/security.test.js                # one suite
npx jest -t "11th /login attempt"             # one test by name
```

Tests use `mongodb-memory-server` (no external Mongo needed) and run with the in-process logger silenced. The `--runInBand --forceExit` flags are required: shared `beforeAll` setup imports `app.js`, which connects to Mongo and starts Apollo asynchronously, so parallel workers race each other.

There is no lint/typecheck step; CommonJS, no TypeScript. Don't add one without being asked.

**Every PR updates `CHANGELOG.md`.** `.github/workflows/changelog.yml` fails any PR to `main` that doesn't touch `CHANGELOG.md` unless the PR carries the `skip-changelog` label (reserved for chores, internal refactors, doc-only fixes). Add a bullet under `## [Unreleased]` in one of the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections — **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, or **Security** — describing the user-visible change. The repo's house style is one dense paragraph per bullet (root cause + the actual fix + why this approach), not a terse "added X" — read the most recent entries before writing yours to match tone and depth. Whenever you commit a behavior change, write the changelog entry in the same commit so the workflow is green on first push.

## Big-picture architecture

**Schema-driven core.** `app.js` walks `schema/versions/*` at boot, and for every schema file it generates: a Mongoose model, a Mongoose-derived GraphQL type with all standard resolvers, a Swagger fragment, and seven REST routes (POST, GET list, PUT bulk, GET/PUT/DELETE by id, plus a `{path}-schema` introspection route). The whole thing is **one big `schemas.forEach` loop in app.js**. To "add a feature to every resource" you almost always edit that loop, not individual schema files.

**Tenant isolation is a hard invariant.** Every auto-generated route scopes by `userId` from the JWT. The REST handlers do this inline (`query.userId = req.user.user_id`); GraphQL is enforced by wrapping each resolver in `utils/scopeResolver.js`. **Never** register a new GraphQL resolver without wrapping it through one of: `wrapFilter`, `wrapCreateOne`, `wrapCreateMany`, `wrapFindById`, `wrapFindByIds`, or `wrapByIdMutation(Model)`. Stamped fields (`userId`, `accountId`) are stripped from generated GraphQL input types so clients can't supply them; the server stamps from the token.

**Role-based ACL is opt-in per schema.** `utils/acl.js` enforces field-level read/create/update visibility plus document-level `list` and `delete` bypasses. Roles travel in the JWT (`req.user.roles` / `ctx.user.roles`); the User model defaults to `['user']`. A schema can declare `field.acl.{read,create,update}` and `schema.acl.{list,delete}`; schemas without an `acl` key behave exactly as before (owner-only). REST and GraphQL wrappers both call into the same helpers, so coverage is symmetric. `wrapFilter`, `wrapByIdMutation`, etc. take an options object — `{ schema, kind: 'read'|'delete'|'write', action: 'create'|'update' }` — to choose which ACL slot applies. `kind` defaults to `'write'` (no bypass).

**Layered middleware order matters.** `app.js` mounts in this order: helmet (CSP carve-out only for `/api-docs` and `/graphql`), CORS allowlist (`CORS_ORIGINS` env), `express.json`, `httpLogger` (pino-http with reqId), `apiLimiter` on `/api/*`. A stable Apollo *indirection* middleware is mounted next — it just delegates to whatever `apolloRouter` currently is — so the schema loader can swap GraphQL's middleware at runtime without touching the parent stack. Then `/register` / `/login` are mounted with `authLimiter`. Then Swagger UI. Then a single `errorHandler` at the end. Because the Apollo indirection is mounted *before* `errorHandler` at boot (rather than inside `server.start().then(...)` as it used to be), one registration is sufficient — REST handlers and Apollo middleware both propagate `next(err)` forward to the same terminal `errorHandler`.

**Schema hot reload.** `utils/schemaLoader.js` builds each schema's REST routes onto its own `express.Router` so unload can splice it from `app._router.stack`. GraphQL is rebuilt end-to-end on every change (new `SchemaComposer`, new `ApolloServer`, new router) and the indirection middleware swaps to point at the new router. All loader operations go through a single-flight queue so concurrent watcher events can't interleave registry mutations with `rebuildGraphQL`. Watching is gated on `NODE_ENV !== 'production' && HOT_RELOAD_SCHEMAS=true`.

**Errors flow through one place.** Throw typed errors from `utils/errors.js` (`NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError`, etc.) wrapped in `asyncHandler`. The middleware in `middleware/errorHandler.js` is the only thing that writes the response shape `{ error: { code, message } }` and is the only thing that maps Mongoose `ValidationError`/`CastError`/`11000`. Do not write `res.status(500).send(err.message)` anywhere — in production, unknown errors are deliberately reduced to `"Internal server error"`.

**Logging.** Use `require('./utils/logger')` (or `req.log` inside request scope) — never `console.log`/`console.error`. Pino is configured with redaction for `authorization`, `cookie`, `set-cookie`, and any `*.password`/`*.token` field. Logger is `silent` when `NODE_ENV=test`.

**Rate limiting tests.** `authLimiter` and `apiLimiter` skip when `NODE_ENV=test` so the suite isn't tripped. Tests that need to assert rate-limit behavior import the factories `buildAuthLimiter`/`buildApiLimiter` from `middleware/rateLimit.js` and pass `skip: () => false` plus an explicit `max`.

## Where to put new code

- New REST handlers for an existing resource → custom routes after the `schemas.forEach` loop in `app.js`. Use `auth(true)` and `asyncHandler`. Prefer a **plugin** (see below) if the code shouldn't live in framework source — e.g. anything in a consumer project that installed davepi as a dep.
- New cross-cutting middleware → `middleware/`.
- New shared helpers / error classes → `utils/`.
- New manually-defined Mongoose models (User-style, not schema-driven) → `model/`.
- New auto-generated resource → a single `schema/versions/v1/{name}.js` file. See `AGENTS.md` for the schema field reference.
- **Per-resource invariants / side effects** (validate before save, send a welcome email after create, refuse delete if dependents exist) → schema-level lifecycle hooks. See "Extensibility" below.
- **Cross-cutting extensions** (audit exports, third-party integrations, scheduled jobs, ad-hoc routes that span resources) → plugins. See "Extensibility" below.

## Extensibility

The framework has two extension points; pick the one that matches the scope of the work.

**1. Schema lifecycle hooks** (per resource). Add a `hooks` block to any schema file:

```js
module.exports = {
  path: 'order',
  collection: 'order',
  fields: [...],
  hooks: {
    beforeCreate: async ({ input, user, req, schema }) => ({ ...input, code: genCode() }),
    afterCreate:  async ({ record, user, req, schema }) => sendWelcome(record),
    beforeUpdate: async ({ input, current, user, req, schema }) => input,
    afterUpdate:  async ({ record, previous, user, req, schema }) => {},
    beforeDelete: async ({ current, user, req, schema }) => { if (current.locked) throw new ForbiddenError('locked'); },
    afterDelete:  async ({ record, user, req, schema }) => {},
  },
};
```

- `before*` hooks run synchronously to the request. Returning a value from `beforeCreate` / `beforeUpdate` **replaces** the input that gets persisted; returning `undefined` keeps it. Throw a typed error from `utils/errors.js` to reject the operation — it flows through `errorHandler` like any other thrown error.
- `after*` hooks run after persistence and are **best-effort**: a thrown error is logged but does not fail the response (same posture as audit and state-machine `onEnter`).
- Coverage: REST `POST` / `PUT /:id` / `DELETE /:id` and GraphQL `{path}CreateOne` / `{path}UpdateById` / `{path}RemoveById`. **Bulk paths intentionally do NOT invoke hooks** — use a plugin subscribing to the event bus for bulk reactions.

**2. Plugins** (cross-cutting). Plugin module specifiers are listed under `davepi.plugins` in the consumer project's `package.json`:

```json
{
  "davepi": {
    "plugins": [
      "./plugins/audit-export.js",
      "davepi-plugin-slack"
    ]
  }
}
```

Each plugin module exports `{ name, async setup({ app, schemaLoader, bus, log, appName }) }`. Plugins load in declaration order, after every schema is registered, so a plugin can introspect `schemaLoader.listSchemas()` and wire a route per resource. The `bus` is the same `EventEmitter` from `utils/events.js` that fires `record` events for every CRUD mutation — the webhook dispatcher uses the same bus, so plugin event subscribers compose with webhooks. After plugins finish loading, the loader re-asserts `errorHandler` at the tail of the middleware stack via `schemaLoader.moveErrorHandlerToEnd()`.

A plugin that throws during `setup` will fail boot. This is deliberate — silently dropping a plugin would hide misconfiguration from operators.

## Conventions worth knowing

- CommonJS only (`require`/`module.exports`).
- Async route handlers must be wrapped in `asyncHandler` so rejections reach `errorHandler`.
- The seed schemas declare `userId` (and sometimes `accountId`) as required fields. The REST POST handler stamps both from `req.user.user_id`; GraphQL wrappers do the same. If you add a new schema and it needs ownership scoping, follow that pattern — don't invent a different field name.
- Apollo Server v3, not v4. `playground` and `introspection` are gated on `NODE_ENV !== 'production'`.
- Tests connect Mongo via `mongodb-memory-server` and `await` the connection event before issuing requests; copy the boilerplate from any of the existing `test/*.test.js` files.
- **Local requires use `#` subpath imports, not `../` ladders.** Every dAvePi project (including the scaffolded ones) ships with `imports` in `package.json` mapping `#plugins/*` → `./plugins/*.js`, `#lib/*` → `./lib/*.js`, `#schema/*` → `./schema/*.js`. Inside a schema file or a plugin, prefer `require('#plugins/postmark')` and `require('#lib/codes')` over `require('../../../plugins/postmark')`. This is [Node's built-in subpath imports](https://nodejs.org/api/packages.html#subpath-imports) — no extra dependency, works in `require`, `import`, and Jest. The trailing `.js` on the mapping target is required: Node's subpath-import resolver does NOT fall back to `.js`/`/index.js` for bare-glob targets, so `"./plugins/*"` would crash MODULE_NOT_FOUND. `#` is the right prefix; `@` is reserved for npm-scoped packages and will not resolve. The framework's own `utils/` is still loaded via the `davepi` package (e.g. `require('davepi/utils/errors')` from a consumer project) — `#` aliases are for the consumer's own files.

## See also

- `AGENTS.md` — exhaustive schema field reference, GraphQL resolver naming, query syntax, and feature catalogue. Use it when you need the full surface; this file is the orientation pass.
- `README.md` — user-facing quick-start and API examples.
