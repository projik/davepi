# Agent guide for this dAvePi project

You are working inside a project built on **dAvePi**, a schema-driven backend
that auto-generates REST + GraphQL + MCP from a single schema file per
resource. Drop a file in `schema/versions/v1/<resource>.js` and the
framework mounts every surface for it without further wiring. Hot reload
is enabled in dev — saving a schema file rebuilds the surface in
50–150ms; no restart.

This guide is the canonical agent contract for working in this project.
Read it before adding code. The full framework reference lives at
<https://docs.davepi.dev>.

## How to think about this project

| Question | Answer |
|----------|--------|
| Where does business data live? | `schema/versions/v1/*.js`. One file per resource. |
| Where do custom routes go? | `index.js` after `require('davepi')`, using `app.locals.schemaLoader` for cross-cutting helpers. Avoid this when an auto-generated route works. |
| How do I add a field? | Edit the schema file. Hot reload picks it up. No migration needed unless you're backfilling. |
| How do I expose data to an agent? | Already done — every schema becomes an MCP tool set automatically. Run `npx davepi mcp` (or use this project's `.mcp.json`). |
| Where's the source of truth for "what this project exposes"? | `GET /_describe` on the running server. Read it before planning anything non-trivial. |

## Build order: constructing a whole app

When the task is "build an app" (not just add one resource), the **order**
is where time gets wasted — almost always by building things the framework
already generates, or by sequencing features so they need rework. Follow
these phases in order. **Each phase leaves the app bootable**; finish one
before starting the next, and lean on hot reload to verify as you go.

**The framework already gives you these — NEVER build them by hand:** auth
(`/register`, `/login`, JWT issue/verify, `userId` + `accountId` stamping),
full CRUD, list pagination / sort / filter (`__page`, `__sort`, `q`,
mongo-querystring), validation, soft-delete + restore + history, audit
logging, file uploads, idempotency, and the REST + GraphQL + MCP + Swagger +
`_describe` surfaces. If you catch yourself writing a login route, a CRUD
handler, or a pagination loop, stop — it already exists.

0. **Orient.** On an existing server, read `GET /_describe` to see what's
   already there. Map every requirement to a *field*, *relation*, *state
   machine*, *aggregation*, *hook*, or *plugin*. Anything that maps to the
   "never build" list above is already done.
1. **Model the domain first — no code yet.** List every entity with its
   fields, its owner (`userId`, always), its foreign keys (`parent<Schema>Id`),
   its finite-state fields, and its relationships. Decide the **role
   taxonomy** now (`user`, `admin`, `support`, `storefront`, …) and which
   resources need cross-tenant or public read. Roles are a *design decision*
   here — applied as ACL in step 4 — not a build phase of their own.
2. **Schemas, structural pass — parents before children.** Write each
   `schema/versions/v1/<resource>.js` with just `path`, `collection`, and
   `fields` (include `userId`, FKs, validation, `searchable`). Entities with
   no FK first (`account`), then their children (`contact`, `deal`). **Save
   one file at a time and confirm it mounts** — hot reload is 50–150ms and
   `_describe` shows the result. Don't write ten files and boot once into a
   cascade of errors.
3. **Wire relationships & behavior.** Now that every entity exists, add
   `relations` (both sides), `stateMachine` fields (with `initial`!),
   `compositeIndex` (`userId`-first), and `aggregations`. These reference
   other schemas *by name*, so all schemas must exist before this pass.
4. **Authorization.** Apply the step-1 roles as ACL: `field.acl.{read,create,update}`,
   `schema.acl.{list,write,delete,scope}`, and `apiClient` rows for public
   `X-Client-Id` reads. Layer this onto a settled data model so you aren't
   re-editing ACL slots as fields churn.
5. **Side effects, last.** Per-resource invariants → schema `hooks`.
   Cross-cutting concerns (integrations, scheduled jobs, exports) → **plugins**,
   which load *after* all schemas and introspect them via
   `schemaLoader.listSchemas()` — that's structurally why they come last.
   Write `#lib/*` helpers **just-in-time**, only when a hook or plugin needs
   one. Never open with a speculative utilities layer.
6. **Verify & finish.** Seed data, run `npm test`, regenerate the typed
   client (`npx davepi gen-client`).

**Wrong starts that cost hours — do NOT do these:**

| Tempting first move | Why it's wrong | Do instead |
|---------------------|----------------|------------|
| Build authentication / login / JWT | Framework-provided. | Skip it — `/register`, `/login`, and `userId` stamping already work. |
| Write CRUD routes / pagination / validation | Auto-generated from each schema. | Just write the schema file. |
| Start with plugins or `#lib/` utilities | They're leaf dependencies that load after and depend on schemas. | Build them last (step 5), only when something needs them. |
| Treat "roles" as a build phase | Roles are data attached to schemas via ACL. | Decide them in step 1, apply as ACL in step 4. |
| Write all schema files, then boot once | Turns one typo into a debugging marathon. | Save and verify one resource at a time via hot reload + `_describe`. |

## To add a resource

Create `schema/versions/v1/<resource>.js`:

```js
module.exports = {
  path: 'task',                                  // URL segment + GraphQL prefix + MCP tool prefix
  collection: 'task',                            // Mongo collection name (conventionally matches path)
  fields: [
    { name: 'userId', type: String, required: true },     // tenant column — MUST be on every schema
    { name: 'title',  type: String, required: true, searchable: true },
    { name: 'done',   type: Boolean, default: false },
  ],
};
```

Save the file. The framework now serves:

- REST: `GET / POST / PUT / DELETE /api/v1/task` plus `/:id`, `/:id/restore`, `/:id/history`
- GraphQL: `taskMany`, `taskById`, `taskCreateOne`, `taskUpdateById`, `taskRemoveById`, etc.
- MCP: `list_task`, `get_task`, `create_task`, `update_task`, `delete_task`, plus restore / history / search where applicable
- Swagger: every route documented at `/api-docs`
- Capability manifest: described at `/_describe`

## Schema field reference

```js
{
  name:        'amount',                         // string, required, camelCase
  type:        Number,                           // String, Number, Boolean, Date, [String], 'File'
  required:    true,                             // Mongoose validation
  default:     0,                                // value or function
  enum:        ['low', 'med', 'high'],           // restricts to a set; surfaces as literal union in TS client
  min:         0,                                // numeric / date bound
  max:         100,
  minLength:   1,                                // string bound
  maxLength:   200,
  match:       /^[A-Z]/,                         // string regex
  trim:        true,                             // string normalizers
  lowercase:   true,
  searchable:  true,                             // joins the schema's full-text index; enables ?q= and search_<path>
  index:       true,                             // single-field index. For per-tenant uniqueness, use compositeIndex (see below)
  acl:         { read: ['admin', 'hr'] },        // field-level ACL — see "ACL" below
  description: 'Deal value in cents.',           // surfaces in Swagger / _describe / TS client doc comment
}
```

### Computed fields

```js
{
  name: 'fullName',
  type: String,
  computed: (record, ctx) => `${record.firstName} ${record.lastName}`,
}
```

Read-only on every surface. Runs at response time. Don't query / sort by
computed fields — they don't exist in Mongo. If you need filtering, mirror
the value as a stored field updated on writes, or use an aggregation.

### State machines

```js
{
  name: 'status',
  type: String,
  stateMachine: {
    initial: 'open',                              // stamped on POST; clients can't pick a non-initial state
    states: ['open', 'in_progress', 'closed'],
    transitions: {
      open:        ['in_progress', 'closed'],
      in_progress: ['open', 'closed'],
      closed:      ['open'],
    },
    onEnter: {                                    // optional side effects per state arrival
      closed: async (record, ctx) => { /* ... */ },
    },
  },
}
```

Invalid transitions reject with `400 INVALID_TRANSITION` carrying
`current / attempted / allowed` — agents read `details.allowed` and
self-correct. Every read includes `availableTransitions[<field>]` so
clients render the right buttons without re-parsing the schema.

How to transition a record:

| Surface | Call |
|---------|------|
| REST | `PUT /api/v1/<path>/:id` with `{ <field>: '<to>' }`. (No dedicated transition route.) |
| GraphQL | `<path>Transition<Field>(_id, to: <to>)` — `to` is typed as the schema's generated enum. The standard `<path>UpdateById` also validates. |
| MCP | `update_<path>` with `{ id, record: { <field>: '<to>' } }`. (No dedicated transition tool.) |
| Typed client | `api.<path>.transition<Field>(id, to)` (convenience wrapper around the REST PUT). |

### File fields

```js
{
  name: 'logo',
  type: 'File',
  file: {
    maxBytes:   5 * 1024 * 1024,
    accept:     ['image/png', 'image/jpeg'],
    storage:    's3',                             // or 'local'
    visibility: 'private',                        // or 'public'
  },
}
```

Uploads go through dedicated multipart routes — never JSON. A `FileMeta`
sub-doc is what's stored in Mongo; the blob lives in your storage backend.

## Top-level schema options

```js
module.exports = {
  path: 'order',
  collection: 'order',
  fields: [/* ... */],

  relations: {                                    // see "Relations" below
    account:  { belongsTo: 'account', fk: 'parentAccountId' },
    items:    { hasMany: 'orderItem', fk: 'orderId' },
  },

  aggregations: [/* see "Aggregations" below */],

  compositeIndex: [                               // unique indexes — ALWAYS lead with userId
    { userId: 1, slug: 1 },
  ],

  softDelete: true,                               // default true. false = hard-delete on DELETE
  audit:      true,                               // default true. false = skip audit log

  acl: {                                          // optional — opt operators in to cross-tenant reads / updates / deletes
    list:   ['admin', 'support'],                 // read across tenants
    write:  ['admin'],                            // update records they don't own (owner preserved)
    delete: ['admin'],                            // delete records they don't own
  },

  webhooks: {                                     // optional — outbound notifications
    events:    ['created', 'updated', 'deleted', 'transitioned'],
    endpoints: [{ url: '...', secret: '...' }],
  },

  softDelete: { retentionDays: 30 },              // optional — auto-purge tombstoned rows. Audit log + webhook_delivery don't auto-purge; prune manually.
};
```

## When to use which feature

| You want to... | Use |
|----------------|-----|
| Store a new piece of data | A field on the schema. |
| Show data derived from other fields | `computed`. Don't denormalise unless you need to filter / sort on it. |
| Show a list of related child records | `hasMany` relation, accessed via `?__include=<rel>`. Re-fetches with tenant scope re-applied. |
| Show a single related parent record | `belongsTo` relation. Same access pattern. |
| Group / count / sum across a tenant's records | Declarative `aggregations[]` entry. The framework prepends `$match: { userId }` automatically. |
| Track a finite-state field (status, stage, phase, etc.) | `stateMachine` config. Don't hand-roll an `enum` + checks. |
| Store an upload | `type: 'File'`. Don't base64 into a String field. |
| Hide a field from non-privileged users | `field.acl.read = ['role']`. Stripped from REST / GraphQL / MCP / audit / webhook payloads. |
| Allow operators to see across tenants | `schema.acl.list = ['role']`. Owner-only is the baseline. |
| Allow operators to update records they don't own | `schema.acl.write = ['role']` (e.g. an admin editing a customer record). Ownership is preserved — tenant fields are stripped from the update. |
| Notify an external system on writes | `webhooks` block. HMAC-SHA256 signed, retries with exponential backoff. |

## First-party plugins — check here before building an integration

Before you write code for email, SMS, payments, social login, background
jobs, scheduling, an audit trail, large-file uploads, or Slack alerts: **a
maintained first-party plugin almost certainly already does it.** Re-implementing
one of these by hand is the integration equivalent of hand-rolling a CRUD route
— wasted effort against something the ecosystem ships. To use one, `npm install`
it and add its npm name to `davepi.plugins` in this project's `package.json`
(see "Plugins" below); each is configured purely through env vars and stays
**dormant** until its credentials are set, so it's safe to declare before wiring
the upstream service.

| Need | Plugin (npm) | What it gives you |
|------|--------------|-------------------|
| Transactional email (welcome, receipt, password-reset) | `davepi-plugin-postmark` | `sendEmail` / `sendTemplate` for use inside hooks; optional auto-send on a matching `record` event. |
| SMS / WhatsApp, OTP passwordless login, TOTP 2FA | `davepi-plugin-twilio` | `sendSms` / `sendWhatsApp`, OTP-over-SMS login routes, 2FA enroll/verify/challenge, inbound-SMS webhook. |
| Payments, subscriptions, billing portal | `davepi-plugin-stripe` | `/api/checkout`, `/api/portal`, signature-verified `/api/webhooks/stripe`; mirrors subscription state into a `stripe_subscription` collection; rebroadcasts events onto the record bus. |
| Social / SSO login (Google, GitHub, Microsoft, Apple, Discord) | `davepi-plugin-oauth` | `/auth/{provider}` + `/callback` routes, CSRF + PKCE, upserts the User and issues the standard JWT. |
| Durable background jobs (slow work out of the request path) | `davepi-plugin-queue` | BullMQ-backed `enqueue` / `registerJob` + a `bus.emit('job:enqueue', …)` channel for hooks; retries, survives restarts. Needs Redis. |
| Scheduled / recurring jobs (nightly export, hourly reap) | `davepi-plugin-cron` | Declarative cron in `package.json`, Mongo-backed distributed lock so only one node fires per tick. No Redis needed. |
| Immutable audit log of every mutation | `davepi-plugin-audit` | Auto-registers an `audit` collection with before/after + JSON-patch diff + actor; queryable via the standard surface. (Note: the framework's per-schema `audit: true` already covers basic history — reach for this plugin when you need the richer queryable diff log.) |
| Slack alerts on events | `davepi-plugin-slack` | Posts to an incoming webhook for every `record` event matching a pattern; `postMessage` for ad-hoc use in hooks. |
| Large / direct-to-bucket file uploads (S3, R2, MinIO, GCS) | `davepi-plugin-object-storage` | Presigned-URL upload/complete/download routes + a first-class `file` collection. Use over `type: 'File'` for multi-GB or serverless uploads. |

`@davepi/agent` deployments also have `davepi-plugin-skill-extractor` (turns
resolved conversations into governed draft skills) — only relevant if you're
running the agent's learning loop.

If a genuinely new integration is needed, build it as a plugin too (see
"Plugins" below) — don't bury cross-cutting code in a schema file or a custom
route.

## Plugins

Plugins are how cross-cutting code (the integrations above, plus your own)
attaches to the app without editing framework source. They load **after every
schema is registered**, in declaration order, so a plugin can introspect
`schemaLoader.listSchemas()` and wire a route or listener per resource.

Register them by listing their module specifiers under `davepi.plugins` in
**this project's** `package.json` — npm package names for first-party plugins,
or `#plugins/<name>` paths for your own:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-postmark", "#plugins/audit-export"]
  }
}
```

A plugin module exports a `name` and an async `setup`:

```js
module.exports = {
  name: 'audit-export',
  async setup({ app, schemaLoader, bus, log, appName }) {
    app.get('/api/v1/_audit-export', auth(true), handler);     // mount routes
    bus.on('record', (e) => { /* e.type === '<path>.created|updated|deleted' */ });
  },
};
```

- `bus` is the same `EventEmitter` that fires a `record` event for every CRUD
  mutation — the right hook for fan-out that spans resources (the integration
  plugins above subscribe to it). For a single resource's side effect, prefer a
  schema `hooks` block over a bus listener.
- A throw during `setup` **fails boot** — that's deliberate, so a
  misconfigured plugin is loud rather than silently dropped.

## Conventions you must follow

- **`userId` is required on every schema.** The framework stamps it from
  the JWT on every write and filters every read. Never set it manually.
- **`accountId` is auto-stamped too.** If your schema needs a foreign key
  to a parent account, name it `parentAccountId` (or `orgId` etc.) —
  anything other than `accountId`.
- **Don't write custom CRUD routes.** The auto-generated REST / GraphQL /
  MCP surfaces cover create / list / get / update / delete / restore /
  history / search / aggregations / file uploads / state-machine
  transitions. Custom routes are for things the schema vocabulary can't
  express.
- **Include `userId` first in every `compositeIndex`.** A `unique: true`
  index on `slug` alone creates a global uniqueness constraint that
  crosses tenants. Use `{ userId: 1, slug: 1 }` instead.
- **Computed is computed.** A field with `computed: () => ...` is never
  writable. Don't add it to POST / PUT bodies — the server strips it.
- **State machines need `initial`.** Without it, the framework can't pick
  a default starting state on POST and creates fail with a validation
  error.
- **Use `#` subpath imports for local requires — never `../` ladders.**
  Every scaffolded project ships with this in `package.json`:

  ```json
  "imports": {
    "#plugins/*": "./plugins/*.js",
    "#lib/*":     "./lib/*.js",
    "#schema/*":  "./schema/*.js"
  }
  ```

  So from a schema file or plugin, write:

  ```js
  const postmark = require('#plugins/postmark');   // ✅ → ./plugins/postmark.js
  const { genCode } = require('#lib/codes');       // ✅ → ./lib/codes.js
  const postmark = require('../../../plugins/postmark');  // ❌ fragile
  ```

  This is [Node's built-in subpath imports](https://nodejs.org/api/packages.html#subpath-imports) —
  no bundler, no extra dep, no `@` prefix (Node reserves `@` for npm-scoped
  packages like `@scope/pkg`; `#` is the standard for local aliases). The
  trailing `.js` on the mapping target is required — Node's resolver does
  not fall back to `.js`/`/index.js` for bare-glob subpath targets. Add
  more entries to `imports` as you grow the project. Framework code from
  the `davepi` package itself stays as `require('davepi/utils/...')`.

## The MCP tool surface

The MCP server exposes one tool set per schema. For schema `path: 'task'`:

| Tool | When | Description |
|------|------|-------------|
| `list_task` | always | Paginated list. `filter` / `sort` / `q` / `include` / `includeDeleted`. |
| `get_task` | always | One record by `_id`. |
| `create_task` | always | Create. Accepts optional `idempotencyKey`. |
| `update_task` | always | Partial update by `_id`. |
| `delete_task` | always | Soft-delete (or hard if `softDelete: false`). |
| `restore_task` | softDelete | Clear `deletedAt`. |
| `history_task` | audit | Audit log for one record. |
| `search_task` | any field has `searchable: true` | Full-text search. |
| `list_task_<rel>` | per `hasMany` | Children of a parent `_id`. |
| `get_task_<rel>` | per `hasOne` / `belongsTo` | Populated relation. |
| `aggregate_task_<name>` | per declared aggregation | Run the named pipeline. |
| _(state-machine transitions)_ | per state-machine field | Use `update_<path>` with `{ id, record: { <field>: <to> } }`. The framework validates against `transitions[current]` and rejects undeclared moves with `INVALID_TRANSITION`. |
| `upload_task_<file>` / `fetch_task_<file>` / `delete_task_<file>` | per file field | Blob lifecycle. |

## Capability discovery: read `_describe` first

```http
GET /_describe
```

Returns a JSON manifest: every schema, every field, every relation,
every aggregation, every state machine, every available endpoint and
MCP tool. **Read this before planning a non-trivial change.** It's the
fastest way to know what the project already has and what's safe to
build on.

## Idempotency: retry safely

Every auto-generated `POST` route accepts an `Idempotency-Key` header.
Same key + same body = original response replayed (with
`Idempotency-Replay: true`). Same key + different body = `409
IDEMPOTENCY_CONFLICT`.

```http
POST /api/v1/task
Idempotency-Key: 9f3c-...
Content-Type: application/json

{ "title": "..." }
```

Every `create_<path>` MCP tool accepts an optional `idempotencyKey`
argument that does the same thing.

**Use a UUID per logical operation, NOT per retry.** Same operation
retried = same key. New operation = new key.

## Aggregations

```js
aggregations: [
  {
    name: 'pipelineByStage',
    description: 'Total amount and count grouped by deal stage.',
    pipeline: [
      { $group: { _id: '$stage', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ],
    cache: { ttlSeconds: 30 },                    // optional in-process cache, per-tenant
    params: [                                     // optional typed inputs
      { name: 'since', type: 'date', match: { createdAt: { $gte: '$since' } } },
    ],
  },
],
```

The framework prepends `$match: { userId }` as the first stage of every
aggregation. Even `unsafe: true` aggregations (which require an
`acl.list` role) still operate within the tenant scope.

## Errors agents should know about

| Code | HTTP | Recoverable | Meaning |
|------|------|-------------|---------|
| `VALIDATION` | 400 | yes | Mongoose / framework validation failed. `details.fields` carries the per-field reasons. |
| `INVALID_ID` | 400 | yes | A path param looks like an ObjectId but isn't valid. |
| `INVALID_TRANSITION` | 400 | yes | State-machine value not declared in `transitions[current]`. Read `details.allowed`. |
| `UNAUTHORIZED` | 401 | usually | Bearer token missing / invalid / expired. |
| `FORBIDDEN` | 403 | no | Token valid, role insufficient. |
| `NOT_FOUND` | 404 | no | Resource doesn't exist for this tenant. (Cross-tenant reads also return 404 — we don't disclose existence.) |
| `DUPLICATE` | 409 | sometimes | Mongo unique-index violation. |
| `IDEMPOTENCY_CONFLICT` | 409 | no | Same key reused with a different body. Pick a new key. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes | Concurrent retry hit the same key. Wait briefly and retry. |
| `RATE_LIMITED` | 429 | yes | Retry after `Retry-After` header. |

Agents should branch on `code`, not the human-readable `message`.

## Common mistakes to avoid

- **Manually wiring `userId`.** `req.user.user_id` is stamped automatically.
  Setting it on the wire either gets stripped (POST) or returns 404
  (GET / PUT / DELETE for another user's record).
- **Using `accountId` as a custom foreign key.** It's auto-stamped from the
  JWT and your client value is overwritten. Use `parentAccountId`,
  `organizationId`, etc.
- **Treating computed fields as writable.** They're stripped from input
  shapes everywhere. If you need to write a value, store it in a regular
  field.
- **State machine without `initial`.** POST will fail because the framework
  can't decide a starting state.
- **Hand-rolling pagination on a list endpoint.** The auto-generated route
  already supports `__page`, `__sort`, `__perPage`, `__include`, `q`,
  `__includeDeleted`, plus mongo-querystring filters.
- **A `unique: true` index without `userId` in the key.** Creates a
  global constraint that crosses tenants. Use a `compositeIndex: [{ userId: 1, ... }]`.
- **Custom routes that re-implement CRUD.** If you find yourself writing
  `Foo.findOne({ _id, userId })`, the auto-generated route already does
  this — call it instead.
- **Skipping `_describe`.** The fastest way to plan a change is to read
  what already exists.

## Worked example: a CRM resource set

The `crm` template ships this; reproduce it from scratch in any project:

### `schema/versions/v1/account.js`

```js
module.exports = {
  path: 'account',
  collection: 'account',
  fields: [
    { name: 'userId',      type: String, required: true },
    { name: 'name',        type: String, required: true, searchable: true },
    { name: 'industry',    type: String },
    { name: 'description', type: String, searchable: true },
  ],
  relations: {
    contacts: { hasMany: 'contact', fk: 'parentAccountId' },
    deals:    { hasMany: 'deal',    fk: 'parentAccountId' },
  },
};
```

### `schema/versions/v1/contact.js`

```js
module.exports = {
  path: 'contact',
  collection: 'contact',
  fields: [
    { name: 'userId',          type: String, required: true },
    { name: 'parentAccountId', type: String, required: true },
    { name: 'name',            type: String, required: true, searchable: true },
    { name: 'email',           type: String },
    { name: 'phone',           type: String },
  ],
  relations: {
    account: { belongsTo: 'account', fk: 'parentAccountId' },
  },
};
```

### `schema/versions/v1/deal.js`

```js
module.exports = {
  path: 'deal',
  collection: 'deal',
  fields: [
    { name: 'userId',          type: String, required: true },
    { name: 'parentAccountId', type: String, required: true },
    { name: 'title',           type: String, required: true, searchable: true },
    { name: 'amount',          type: Number, required: true },
    { name: 'closedAt',        type: Date },
    {
      name: 'stage',
      type: String,
      stateMachine: {
        initial: 'lead',
        states: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
        transitions: {
          lead:        ['qualified', 'lost'],
          qualified:   ['proposal', 'lost'],
          proposal:    ['negotiation', 'won', 'lost'],
          negotiation: ['won', 'lost'],
          won:         [],
          lost:        ['lead'],
        },
      },
    },
  ],
  relations: {
    account: { belongsTo: 'account', fk: 'parentAccountId' },
  },
  aggregations: [
    {
      name: 'pipelineByStage',
      description: 'Total amount and count grouped by deal stage.',
      pipeline: [
        { $group: { _id: '$stage', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ],
      cache: { ttlSeconds: 30 },
    },
  ],
};
```

That's the whole CRM. Save the files; the framework mounts:

- REST routes for each resource plus `/api/v1/deal/aggregations/pipelineByStage`. Stage transitions go through the standard `PUT /api/v1/deal/:id` with `{ stage: 'qualified' }` — the framework validates against `transitions[current]`.
- GraphQL types and resolvers (`accountMany`, `dealUpdateById`, `dealTransitionStage`, etc.).
- MCP tools (`create_account`, `update_deal`, `list_account_contacts`, `aggregate_deal_pipelineByStage`, ...). Transitions ride on `update_deal` with `{ id, record: { stage: '<to>' } }`.
- Swagger docs.
- A `_describe` manifest entry for each.

## Prompt templates

Copy and adapt these — they encode the conventions above so the model
makes the same decisions you would.

### Add a resource

> Add a `<resource>` resource with these fields: <list of name + type +
> required>. Tenant column is `userId` (required, auto-stamped). If a
> foreign key to an existing schema is needed, name it
> `parent<Schema>Id` (don't use `accountId` for custom FKs). Don't write
> a custom route — the auto-generated CRUD covers it.

### Add a state machine

> Add a `<field>` state-machine field on `<resource>` with states
> `[<states>]`, initial `<state>`, and transitions <list>. Don't write
> validation logic — the framework rejects undeclared transitions with
> `INVALID_TRANSITION` automatically.

### Add a relation

> On `<parent>`, add a `<name>` `hasMany`/`hasOne`/`belongsTo` relation
> to `<target>` with foreign key `<fk>`. Use `__include=<name>` to
> populate it on reads. Don't manually populate — the relations engine
> batches the query and re-applies tenant scope.

### Add an aggregation

> On `<resource>`, add an aggregation `<name>` that <description>.
> Pipeline: <stages>. The framework prepends `$match: { userId }`
> automatically — don't add it.

### Add a computed field

> Add a computed field `<name>` on `<resource>` of type `<type>` that
> returns `<expression>`. Don't store it. The framework runs the
> function on every read and includes it in responses, GraphQL output,
> MCP results, and the typed client.

## Useful commands

- `npm start` — boot the server (dev, hot-reload).
- `npm test` — run the schema-shape smoke tests under `tests/`. Add your own integration tests alongside.
- `npm run seed` — register a demo user and POST sample records (template-dependent).
- `npx davepi gen-client --out client/davepi.ts` — regenerate the typed TS client.
- `npx davepi migrate up` — apply pending data migrations.
- `npx davepi mcp` — run the MCP server over stdio (used by `.mcp.json`).
- `curl -s http://localhost:{{PORT}}/_describe | jq` — inspect what the project exposes.

## Where to look next

- Full framework reference: <https://docs.davepi.dev>
- Schema field options: <https://docs.davepi.dev/reference/fields/>
- Per-feature deep dives: <https://docs.davepi.dev/features/>
- Idempotency contract: <https://docs.davepi.dev/features/idempotency/>
- MCP server reference: <https://docs.davepi.dev/surfaces/mcp/>
- TypeScript client: <https://docs.davepi.dev/surfaces/client/>
