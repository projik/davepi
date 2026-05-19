---
title: Conventions
description: Naming rules, where to put new code, and the patterns the framework expects you to follow.
---

dAvePi is opinionated. The conventions below let the schema-driven
machinery do its job — break them and you'll lose generated tools,
typed client methods, or tenant scoping.

## Naming

### Resource paths

| Surface | Form | Example |
|---------|------|---------|
| Schema file | `schema/versions/v1/<path>.js` | `account.js` |
| `path` value | singular, lowercase, hyphens for compounds | `'account'`, `'order-item'` |
| REST URL | `/api/v1/<path>` (also `<path>/:id`) | `/api/v1/account` |
| GraphQL queries | `<path>One`, `<path>Many`, `<path>ById`, ... | `accountMany` |
| MCP tools | `list_<path>`, `create_<path>`, `update_<path>`, `delete_<path>`, ... | `create_account` |

`path` should be **singular** by convention — graphql-compose pluralises
into `<path>Many` automatically, and the MCP tool list reads more
naturally with a singular base.

### Field names

- camelCase: `firstName`, `closedAt`, `parentAccountId`.
- The two stamped tenant fields are always `userId` and `accountId`. Don't rename, don't repurpose.
- Foreign keys: `<target>Id` for the convention the relations engine expects (e.g. `accountId` referencing the `account` schema).
- File fields: any name; the framework generates routes from `path` + field name.

### State-machine names

The literal values inside `states` are stable contracts — they
appear in PUT bodies, GraphQL enum values, MCP `update_<path>`
arguments, and the typed client's literal unions. Pick names you
can live with: `'won'` not `'WON'`, `'in_progress'` not
`'inProgress'`.

## Tenant fields

`userId` is **the** tenant column. Two rules:

1. **Don't use `accountId` as a custom FK.** It's stamped from the JWT and overwritten on every write — your client value disappears.
2. **Always include `userId` first in any `compositeIndex`.** A `unique: true` index on `slug` alone creates a global uniqueness constraint that crosses tenants; use `{ userId: 1, slug: 1 }` instead.

Custom FKs should be named `parentAccountId`, `organizationId`,
etc. — anything other than `userId` / `accountId`.

## Where to put new code

| You're adding... | Go here |
|------------------|---------|
| A new auto-generated resource | `schema/versions/v1/<name>.js` (one file, schema vocabulary only). |
| A per-resource invariant or side effect (validate before save, fire on create, refuse delete) | A `hooks` block on the schema file. See [Lifecycle hooks](/features/hooks/). |
| A cross-cutting extension (audit export, integration, scheduled job, route per resource) | A [plugin](/features/plugins/) — register it in `package.json` → `davepi.plugins`. |
| A custom REST handler that lives in framework source | After the `schemas.forEach` loop in `app.js`, with `auth(true)` and `asyncHandler`. (Prefer a plugin if davepi is installed as a dep.) |
| Cross-cutting middleware | `middleware/`. Mount in `app.js` between the existing layers. |
| A typed error class | Add to `utils/errors.js`. The terminal error handler in `middleware/errorHandler.js` already maps anything that extends the base. |
| A shared helper / framework feature | `utils/`. Wire it into the schema loader if it needs to participate in load / unload. |
| A manually-defined Mongoose model (User-style, not schema-driven) | `model/`. Don't try to merge with the schema-driven path. |

The auth flow (`/login`, `/register`, password hashing) is
hand-written under `routes/auth/` and `model/user.js`. It deliberately
sits outside the schema-driven pipeline — auth bootstraps the JWT
that every other handler relies on.

## Async handlers

Every async route must be wrapped:

```js
const asyncHandler = require('./utils/asyncHandler');
const { NotFoundError } = require('./utils/errors');

app.get('/api/v1/foo/:id/custom', auth(true), asyncHandler(async (req, res) => {
  const doc = await Foo.findOne({ _id: req.params.id, userId: req.user.user_id });
  if (!doc) throw new NotFoundError('foo not found');
  res.json(doc);
}));
```

`asyncHandler` forwards rejections to `next()` so the terminal
`errorHandler` can format the response shape. Don't write
`res.status(500).send(err.message)` — production reduces unknown
errors to `"Internal server error"` deliberately.

## Logging

Use `req.log` inside a request scope, or `require('./utils/logger')`
elsewhere. **Never** `console.log` — Pino is configured with
redaction (`authorization`, `cookie`, `*.password`, `*.token`), and
the test suite silences it via `NODE_ENV=test`.

```js
req.log.info({ userId: req.user.user_id }, 'creating account');
req.log.error({ err }, 'mongo write failed');
```

## GraphQL resolvers

If you write a custom GraphQL resolver, **wrap it in `utils/scopeResolver.js`** —
otherwise tenant scoping is bypassed.

```js
const { wrapFilter, wrapByIdMutation } = require('./utils/scopeResolver');

tc.addResolver({
  name: 'foosWithBars',
  resolve: wrapFilter(/* options */, async (rp, ctx) => {
    // rp.args.filter has userId injected
  }),
});
```

The wrappers take an options object: `{ schema, kind: 'read'|'delete'|'write', action: 'create'|'update' }`.
`kind` defaults to `'write'`. Use `'read'` to honour `acl.list` on
the schema; use `'delete'` for `acl.delete`.

## Tests

`mongodb-memory-server` is the test backend — no external Mongo
needed. The `--runInBand --forceExit` flags are mandatory: shared
`beforeAll` setup imports `app.js`, which connects to Mongo
asynchronously, and parallel workers race each other.

```bash
npm test                                           # full suite
npx jest test/security.test.js                     # one suite
npx jest -t "rejects cross-tenant read"            # one test by name
```

Rate limiters skip when `NODE_ENV=test`. Tests that need to assert
rate-limit behaviour import the factories
(`buildAuthLimiter` / `buildApiLimiter`) and pass `skip: () => false`.

## CommonJS only

dAvePi is CommonJS — `require` / `module.exports`. There's no
TypeScript, no ESM, no transpile step. Don't introduce one
without a deliberate decision: the lack of a build is part of
why hot reload is fast and why scaffolding produces a project
the user can `git clone` and run.

(The generated *client* is TypeScript, but it's an output, not part
of the server.)

## See also

- [Schema file shape](/reference/schema/) — what goes in a schema file.
- [Field options](/reference/fields/) — what goes in `fields[]`.
- [Tenant isolation](/concepts/tenancy/) — why `userId` and `accountId` are special.
