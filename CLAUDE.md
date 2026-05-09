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

## Big-picture architecture

**Schema-driven core.** `app.js` walks `schema/versions/*` at boot, and for every schema file it generates: a Mongoose model, a Mongoose-derived GraphQL type with all standard resolvers, a Swagger fragment, and seven REST routes (POST, GET list, PUT bulk, GET/PUT/DELETE by id, plus a `{path}-schema` introspection route). The whole thing is **one big `schemas.forEach` loop in app.js**. To "add a feature to every resource" you almost always edit that loop, not individual schema files.

**Tenant isolation is a hard invariant.** Every auto-generated route scopes by `userId` from the JWT. The REST handlers do this inline (`query.userId = req.user.user_id`); GraphQL is enforced by wrapping each resolver in `utils/scopeResolver.js`. **Never** register a new GraphQL resolver without wrapping it through one of: `wrapFilter`, `wrapCreateOne`, `wrapCreateMany`, `wrapFindById`, `wrapFindByIds`, or `wrapByIdMutation(Model)`. Stamped fields (`userId`, `accountId`) are stripped from generated GraphQL input types so clients can't supply them; the server stamps from the token.

**Layered middleware order matters.** `app.js` mounts in this order: helmet (CSP carve-out only for `/api-docs` and `/graphql`), CORS allowlist (`CORS_ORIGINS` env), `express.json`, `httpLogger` (pino-http with reqId), `apiLimiter` on `/api/*`. Then schema-loading registers REST routes. Then `/register` / `/login` are mounted with `authLimiter`. Then Swagger UI. Then `errorHandler` is registered **twice** — once synchronously, once again inside `server.start().then(...)` after Apollo's `applyMiddleware` mounts `/graphql/`, because Apollo's mount is async and Express middleware runs in registration order. Don't remove the second registration.

**Errors flow through one place.** Throw typed errors from `utils/errors.js` (`NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError`, etc.) wrapped in `asyncHandler`. The middleware in `middleware/errorHandler.js` is the only thing that writes the response shape `{ error: { code, message } }` and is the only thing that maps Mongoose `ValidationError`/`CastError`/`11000`. Do not write `res.status(500).send(err.message)` anywhere — in production, unknown errors are deliberately reduced to `"Internal server error"`.

**Logging.** Use `require('./utils/logger')` (or `req.log` inside request scope) — never `console.log`/`console.error`. Pino is configured with redaction for `authorization`, `cookie`, `set-cookie`, and any `*.password`/`*.token` field. Logger is `silent` when `NODE_ENV=test`.

**Rate limiting tests.** `authLimiter` and `apiLimiter` skip when `NODE_ENV=test` so the suite isn't tripped. Tests that need to assert rate-limit behavior import the factories `buildAuthLimiter`/`buildApiLimiter` from `middleware/rateLimit.js` and pass `skip: () => false` plus an explicit `max`.

## Where to put new code

- New REST handlers for an existing resource → custom routes after the `schemas.forEach` loop in `app.js`. Use `auth(true)` and `asyncHandler`.
- New cross-cutting middleware → `middleware/`.
- New shared helpers / error classes → `utils/`.
- New manually-defined Mongoose models (User-style, not schema-driven) → `model/`.
- New auto-generated resource → a single `schema/versions/v1/{name}.js` file. See `AGENTS.md` for the schema field reference.

## Conventions worth knowing

- CommonJS only (`require`/`module.exports`).
- Async route handlers must be wrapped in `asyncHandler` so rejections reach `errorHandler`.
- The seed schemas declare `userId` (and sometimes `accountId`) as required fields. The REST POST handler stamps both from `req.user.user_id`; GraphQL wrappers do the same. If you add a new schema and it needs ownership scoping, follow that pattern — don't invent a different field name.
- Apollo Server v3, not v4. `playground` and `introspection` are gated on `NODE_ENV !== 'production'`.
- Tests connect Mongo via `mongodb-memory-server` and `await` the connection event before issuing requests; copy the boilerplate from any of the existing `test/*.test.js` files.

## See also

- `AGENTS.md` — exhaustive schema field reference, GraphQL resolver naming, query syntax, and feature catalogue. Use it when you need the full surface; this file is the orientation pass.
- `README.md` — user-facing quick-start and API examples.
