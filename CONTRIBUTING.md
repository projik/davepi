# Contributing to dAvePi

Thanks for considering a contribution. This file covers the
practical pieces: getting the dev environment running, the
project's conventions, what review looks like, and where to ask
questions when this file isn't enough.

If you're using dAvePi as the backend for your own project (rather
than contributing to the framework itself), the
[agent guide](./templates/_shared/agent.md) and the
[docs site](https://docs.davepi.dev) are the better starting
points. This file is for people changing dAvePi's own code.

## Where to start

| You want to... | Go to |
|----------------|-------|
| Report a bug | [Open an issue](https://github.com/projik/davepi/issues/new/choose) — pick "Bug report". |
| Suggest a feature | [Open an issue](https://github.com/projik/davepi/issues/new/choose) — pick "Feature request". |
| Ask a usage question | [GitHub Discussions → Q&A](https://github.com/projik/davepi/discussions/categories/q-a). Don't open an issue for "how do I do X". |
| Show what you built | [Discussions → Show & Tell](https://github.com/projik/davepi/discussions/categories/show-and-tell). |
| Disclose a security issue | **Don't** open a public issue. Follow [SECURITY.md](./SECURITY.md). |
| Chat with maintainers / other contributors | TBD — Discord invite link will land in the README. |

## Dev environment

```bash
git clone https://github.com/projik/davepi.git
cd davepi
npm install
cp .env.example .env        # MONGO_URI / TOKEN_KEY / API_PORT live here
# Open .env and replace TOKEN_KEY with a real random string.
# (One-liner: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
docker compose up -d        # local Mongo on :27017
npm start                   # dev server with nodemon
```

`index.js` reads the `.env` via dotenv before connecting to Mongo;
without a `.env`, startup fails at the DB connect step. The
`MONGO_URI` in `.env.example` matches the Docker Compose Mongo
above, so the only mandatory edit is `TOKEN_KEY`.

Tests use `mongodb-memory-server`, so they don't need the Docker
Mongo — but if you want to point a manual `curl` at a real
instance during development, the docker-compose Mongo is the
easiest path.

```bash
npm test                    # full Jest suite, ~2 minutes
npx jest test/security.test.js   # one suite
npx jest -t "tenant isolation"   # by name
```

Important flags: `--runInBand --forceExit` are mandatory and
already in the `test` script — the shared `beforeAll` setup imports
`app.js`, which connects to Mongo and starts Apollo asynchronously,
so parallel workers race each other.

There is **no lint or typecheck step**. The project is CommonJS,
no TypeScript. Don't add a build / lint config without first
opening an issue to discuss — it'd change the contributor
experience for everyone.

## Project layout

```
app.js                    Express app construction (read top-to-bottom)
index.js                  Boots app.js and calls app.listen()
bin/davepi.js             CLI (migrate, gen-client, mcp stdio)
config/                   Mongo connection, env reading
middleware/               errorHandler, httpLogger, rate limiters, metrics
model/                    Manually-defined Mongoose models (User-style)
routes/                   Hand-written routes (auth, file uploads, webhooks)
schema/versions/v1/       Auto-generated resource schemas (read AGENTS.md)
utils/                    Cross-cutting helpers (errors, logger, scopeResolver,
                          schemaLoader, mcpServer, idempotency, ...)
test/                     Jest test suite
client/                   davepi-runtime.ts (hand-written) +
                          generated clients ship here
docs/site/                Astro Starlight docs site (docs.davepi.dev)
packages/mcp/             @davepi/mcp npm package
create-davepi-app/        npx create-davepi-app scaffolder
templates/                Project templates the scaffolder copies from
eval/                     Agent eval harness
```

[CLAUDE.md](./CLAUDE.md) has the orientation pass for AI coding
agents; humans should read it too — it documents the architectural
invariants (tenant isolation, error envelope, middleware order)
that aren't always obvious from the code.

## Conventions

### Code style

- **CommonJS only.** `require`/`module.exports`. No ESM, no TypeScript.
- **`asyncHandler` on every async route.** Rejections must reach the
  centralised `errorHandler`. Don't call `res.status(500).send()`
  inline.
- **Use `req.log` or `require('./utils/logger')`.** Never `console.*`.
  Pino is configured with redaction; bypassing it leaks secrets.
- **Throw typed errors from `utils/errors.js`** (`NotFoundError`,
  `ValidationError`, etc.). The terminal `errorHandler` produces
  the `{ error: { code, message } }` envelope.
- **`auth(true)` on every protected route.** Don't trust
  `req.user` without it.
- **Tenant scope is non-bypassable.** Custom GraphQL resolvers must
  be wrapped via `utils/scopeResolver.js` (`wrapFilter`,
  `wrapByIdMutation`, etc.). Custom REST handlers must include
  `userId: req.user.user_id` in every Mongoose query.

### Commits

- Aim for one logical change per commit. A commit message that
  reads "address review feedback" should land as a `git commit
  --fixup` if you're squashing, or carry a clearer subject if not.
- Subject line in present tense, ≤ 72 characters. Body explains
  the **why**, not the what.
- No conventional-commits prefix required. Recent history is a fine
  template — `git log --oneline -20`.

### Pull requests

PRs use the [template](./.github/PULL_REQUEST_TEMPLATE.md):

1. **Summary** — 1-3 sentences on what changed.
2. **Why** — link the issue or describe the motivation.
3. **Test plan** — what you ran, what you saw. Include any manual
   verification.
4. **Screenshots** — only if the change touches the admin SPA or
   the docs site.

Mark draft PRs as draft. Maintainers won't review until you mark
ready.

### Adding a feature

The framework prefers to express features through the schema
vocabulary (schema-level options, field-level flags) rather than
ad-hoc routes. Before adding a new endpoint, ask: "could this be
a schema option instead?" The answer is usually yes — that's why
the framework is small.

Cross-cutting features go in `utils/`, get wired into the
`schemas.forEach` loop in `app.js`, and surface across REST,
GraphQL, MCP, Swagger, the admin SPA, and the typed client in
lockstep. See past PRs (#33 webhooks, #36 soft-delete + audit,
#40 relations, #50 computed) for the pattern.

### CHANGELOG

Every user-visible change adds an entry under `## [Unreleased]`
in [CHANGELOG.md](./CHANGELOG.md). The `Changelog` CI workflow
fails PRs that don't update it; apply the `skip-changelog` label
if the PR is genuinely changelog-irrelevant (chore, internal
refactor, doc-only).

Pick the right section: Added / Changed / Deprecated / Removed /
Fixed / Security. One sentence on the user impact, plus the PR
number.

## Review

PRs are reviewed by [a maintainer](./MAINTAINERS.md) — currently
@projik. Expect:

- A first response within a few days.
- Comments tagged for severity. Anything tagged "blocking" must
  be addressed before merge; "nit" / "suggestion" / "follow-up"
  are optional.
- Pushback is normal. The framework's invariants (tenant
  isolation, error envelope, schema-driven generation) are tight
  by design — a change that bends them needs a strong rationale.

If a PR has been sitting for over two weeks without review, ping
the issue or @-mention a maintainer in the PR. The queue gets
deep occasionally.

## Tests

New code must come with tests. Specifically:

- New REST surface → an integration test that exercises the
  happy path and a typical error case.
- New schema-level option → tests that exercise it on at least
  one of the existing templates.
- New typed error → test that asserts the `code`/`status`/`message`
  shape on a real request.
- Bug fix → a regression test that fails before the fix and
  passes after.

Tests live in `test/*.test.js`. The harness in `test/helpers.js`
boots the framework against `mongodb-memory-server`, registers
test users, and gives you a supertest agent against a fresh app.

## Releases

Versioning follows [semver from v1.0.0 onward](https://docs.davepi.dev/reference/stability/).
Release commits update the `## [Unreleased]` section in
CHANGELOG.md into a versioned `## [X.Y.Z]` section with the date,
then tag `vX.Y.Z` on `main`. Maintainers handle the tag push.

Subpackages (`@davepi/mcp`, etc.) have their own publish
workflows triggered by their own tags (e.g. `@davepi/mcp@1.0.0`).

## License

Contributions are accepted under the same license the project
ships under — see [`package.json`](./package.json). By submitting
a PR, you affirm you have the right to license your contribution
that way.
