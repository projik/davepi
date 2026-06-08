---
title: From Hasura
description: Migrate from Hasura to dAvePi — tracked tables → schema files, row/column permissions → ACL, event triggers → webhooks, Actions → custom routes.
---

Hasura is the closest "schema → API" cousin of dAvePi — both
generate API surfaces from declared shapes, both use JWT claims,
both have console-driven or file-driven permission models. The
move from Hasura to dAvePi is mostly about translating the
**metadata** (permissions, relationships, event triggers,
Actions) since the table schema itself comes from your
Postgres database.

If you're on Hasura with a Postgres backend, this guide covers
the Hasura side; the underlying Postgres → Mongo data shift is
the same pattern as [the Supabase guide](/migrate-from/supabase/).

## What moves

| Hasura | dAvePi | Notes |
|--------|--------|-------|
| Tracked table | `schema/versions/v1/<resource>.js` | One file per tracked table. |
| Column → type | `{ name, type }` in `fields[]` | Same Postgres → Mongo mapping as Supabase. |
| Object relationship | `relations: { x: { kind: 'belongsTo', resource: ..., fk: '...' } }` | The FK column stays a `String`; the relationship is named. |
| Array relationship | `relations: { x: { kind: 'hasMany', resource: ..., fk: '...' } }` | Many side. |
| Remote relationship | (no direct map) | dAvePi doesn't federate; expose the remote in a custom route. |
| Permission rule (select) | `acl.list` (cross-tenant) or default tenant scope | Per-row checks → document ACL. |
| Permission rule (insert/update/delete) | `acl.write` for cross-tenant update, `acl.delete` for cross-tenant delete; field `acl.create` / `acl.update` for column-level | Column permissions → field ACL. Insert always stamps ownership — no cross-tenant create. |
| Event trigger | `webhooks: [{ event: 'create' | 'update' | 'delete' | ..., url }]` on the schema | HMAC-signed, declared per-schema. |
| Action (REST proxy) | Custom Express route in `index.js` | Move handler code out of webhook+Action into a direct route. |
| Action (no proxy — just a mutation) | Custom GraphQL resolver via `app.locals.schemaLoader` or a schema-level method | Rare. Most Actions hit an external HTTP API; those are simpler as a direct route. |
| Cron trigger | `node-cron` in `index.js` or your platform's cron | dAvePi has no built-in cron scheduler. |
| Scheduled trigger | A queue + a worker, or your platform's scheduler | Same — not built in. |
| `X-Hasura-User-Id` session var | `userId` (auto-stamped from JWT) | The "owner" pattern is the default. |
| `X-Hasura-Role` | `req.user.roles` (JWT claim) | Multi-role: dAvePi's User model has `roles: [String]`. |
| Custom JWT secret | `TOKEN_KEY` env var | Single shared secret, HS256. |

## Field-type mapping

Same Postgres → Mongo mapping as
[the Supabase guide](/migrate-from/supabase/#field-type-mapping).
The interesting Hasura-specific cases:

| Hasura concept | dAvePi |
|----------------|--------|
| Computed field (SQL function) | `computed: (record, ctx) => ...` |
| Auto-generated `updated_at` trigger | `timestamps: true` on the schema (default) |
| Hasura `id uuid` PK | Mongo `_id: ObjectId`. Keep the UUID as `legacyId` for the cutover window. |
| Enum table | Field with `enum: [...]` |
| Native Postgres enum | Same — `enum: [...]` |

## Permission rules → ACL

Hasura's permission model is row + column rules per role per
operation. dAvePi's ACL is document-level (`list` / `write` /
`delete`) + field-level (`read` / `create` / `update`).

### Row-level: "user owns their rows"

```yaml
# Hasura metadata excerpt
- role: user
  permission:
    filter:
      user_id: { _eq: X-Hasura-User-Id }
    columns: '*'
```

```js
// dAvePi: default behaviour
module.exports = {
  path: 'deal',
  fields: [
    { name: 'userId', type: String, required: true },
    /* ... */
  ],
  // No acl block needed — tenant scoping is automatic.
};
```

### Row-level: admin sees everything

```yaml
- role: admin
  permission:
    filter: {}                        # no row restriction
    columns: '*'
```

```js
{
  path: 'deal',
  fields: [/* ... */],
  acl: {
    list:   ['admin'],     // bypass userId scope on reads
    write:  ['admin'],     // update records owned by other users
    delete: ['admin'],
  },
}
```

### Column-level: hide salary from non-HR

```yaml
- role: user
  permission:
    filter: { user_id: { _eq: X-Hasura-User-Id } }
    columns: [id, first_name, last_name, email]   # salary omitted
- role: hr
  permission:
    filter: {}
    columns: '*'
```

```js
{
  path: 'employee',
  fields: [
    { name: 'userId',    type: String, required: true },
    { name: 'firstName', type: String },
    { name: 'lastName',  type: String },
    { name: 'email',     type: String },
    {
      name: 'salary',
      type: Number,
      acl: { read: ['admin', 'hr'], create: ['admin', 'hr'], update: ['admin', 'hr'] },
    },
  ],
  acl: { list: ['admin', 'hr'] },
}
```

### Complex row filter

```yaml
- role: user
  permission:
    filter:
      _or:
        - { user_id: { _eq: X-Hasura-User-Id } }
        - { shared_with: { _has_key: X-Hasura-User-Id } }
```

There's no direct map for "row is visible if X is in the
`shared_with` JSON object". You have two options:

1. **Compute the visible set in app code.** Add a `viewers: [String]` array of `userId`s on the schema; use `acl.list: ['admin']` to allow cross-tenant reads, and add a custom route that filters by `{ $or: [{ userId }, { viewers: userId }] }`.
2. **Use a sharing collection.** `shares: { resource, recordId, userId }` joined at read time. More work, more flexible.

The first option is the right shape if "sharing" is a small,
bounded feature; the second if sharing is a first-class part of
the product.

## Relationships → relations map

```yaml
# Hasura
- name: account
  using:
    foreign_key_constraint_on: account_id      # object relationship
- name: deals
  using:
    foreign_key_constraint_on:
      table: deals
      column: account_id                       # array relationship
```

```js
// dAvePi
// schema/versions/v1/deal.js
relations: {
  account: { kind: 'belongsTo', resource: 'account', fk: 'accountId' },
},

// schema/versions/v1/account.js
relations: {
  deals: { kind: 'hasMany', resource: 'deal', fk: 'accountId' },
},
```

Both sides of the relationship can declare a `relations` entry;
each side gets its own named accessor (`__include=account` on
deal reads, `__include=deals` on account reads).

The FK column is a plain `String` — no Postgres-style
`REFERENCES` constraint. Referential integrity is enforced at
write time only if you add a `validate` function or check
relations in app code.

## Event triggers → subscription webhooks

dAvePi's webhooks are subscription-based: register one URL per
event-pattern set via `POST /api/v1/webhooks`. The framework
emits events from the auto-generated mutations and dispatches
them to matching subscriptions.

```yaml
# Hasura
- name: deal_change
  table: { name: deals, schema: public }
  webhook: https://example.com/hook
  definition:
    insert: { columns: '*' }
    update: { columns: '*' }
    delete: { columns: '*' }
```

```bash
# dAvePi: one subscription that covers all three with a wildcard
curl -X POST https://api.example.com/api/v1/webhooks \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "events": ["deal.*"],
    "url": "https://example.com/hook"
  }'
```

The response contains a `secret` field, shown exactly once.
Save it; it's used for HMAC verification on every delivery.

Event types emitted: `<path>.created`, `<path>.updated`,
`<path>.deleted`, `<path>.transitioned`. Patterns: exact,
`<resource>.*`, or `*` (global).

### Delivery shape

Each POST carries headers:

```http
X-davepi-Signature: sha256=<hex>
X-davepi-Event:     deal.created
X-davepi-Delivery:  <uuid>
```

`X-davepi-Signature` is `HMAC_SHA256(secret, rawBody)`,
hex-encoded:

```js
const expected = 'sha256=' +
  crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
if (req.headers['x-davepi-signature'] !== expected) return res.status(401).end();
```

### Payload

```json
{
  "id":          "<uuid>",
  "type":        "deal.created",
  "version":     "v1",
  "userId":      "<tenant>",
  "recordId":    "<doc-id>",
  "record":      { /* current record */ },
  "deliveredAt": "2026-05-11T12:00:00Z"
}
```

Bulk operations emit `filter` + `numAffected` instead of
`recordId` + `record`.

### Differences worth knowing

- **No `before` document.** Hasura event triggers include the old row on update / delete. dAvePi doesn't — if you need the prior state, query the audit log (`GET /api/v1/<path>/:id/history`) from the receiver.
- **Retries with backoff.** Failed deliveries retry on 1s / 5s / 30s / 5m / 1h. After 10 consecutive failures the subscription auto-disables. Receivers must be idempotent.
- **No ordering guarantee.** Delivery is best-effort fan-out from a process-local event bus; if strict ordering matters, persist the event server-side first or read the audit log in order.
- **No filter rules.** Hasura's "fire only on column X change" — replicate that with logic in your webhook receiver, or in the event payload (which carries the full record).
- **Per-tenant.** Subscriptions are scoped to the creating user's `userId`; you only receive events for records owned by that tenant.

## Actions → custom routes

Hasura Actions are essentially a typed wrapper around a remote
HTTP handler. Most Actions are "call this external API, return
its result." Move that handler directly into `index.js`:

```js
// index.js (after `require('davepi')`)
const { auth, asyncHandler } = require('davepi');

app.post('/api/v1/checkout', auth(true), asyncHandler(async (req, res) => {
  const { amountCents, dealId } = req.body;
  // … your Stripe / business logic …
  res.json({ ok: true, sessionId: '...' });
}));
```

For Actions that wrote rows in Hasura (using the GraphQL
mutation under the hood), use the generated model directly:

```js
const Deal = mongoose.model('deal');
const created = await Deal.create({
  userId: req.user.user_id,            // tenant column
  title: req.body.title,
  /* ... */
});
res.status(201).json(created);
```

The framework's standard error handler picks up Mongoose
validation errors and renders them as `400 VALIDATION`.

## ETL template

Hasura sits on top of Postgres, so the ETL is the same shape as
the [Supabase ETL template](/migrate-from/supabase/#the-etl-template).
Use `pg_dump` or a direct `pg` connection, batch into
`Model.collection.insertMany`, and rewrite `legacyId` references
after every collection is populated.

```js
// scripts/etl/deals.js — Hasura-flavoured
require('dotenv').config();
const mongoose = require('mongoose');
const { Client } = require('pg');
const { buildLegacyMap } = require('./helpers');   // defined in the Supabase guide

const BATCH = 500;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Deal = mongoose.model('deal');
  const userMap = await buildLegacyMap('user');
  const accountMap = await buildLegacyMap('account');

  const pg = new Client({ connectionString: process.env.HASURA_DB_URL });
  await pg.connect();

  let offset = 0;
  for (;;) {
    const { rows } = await pg.query(
      `SELECT * FROM public.deals ORDER BY id LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    );
    if (!rows.length) break;

    const docs = rows.map((row) => ({
      _id:         new mongoose.Types.ObjectId(),
      legacyId:    row.id,
      userId:      (userMap.get(row.user_id) || '').toString(),
      accountId:   (accountMap.get(row.account_id) || '').toString(),
      title:       row.title,
      amountCents: Math.round(Number(row.amount) * 100),
      status:      row.status,
      createdAt:   row.created_at,
      updatedAt:   row.updated_at,
    })).filter((d) => d.userId && d.accountId);

    if (docs.length) {
      await Deal.collection.insertMany(docs, { ordered: false });
    }
    console.log(`offset=${offset} inserted=${docs.length}`);
    offset += BATCH;
  }
  await pg.end();
  await mongoose.disconnect();
})();
```

`buildLegacyMap` is the helper that builds a `legacyId → _id`
lookup — defined in the
[Supabase guide](/migrate-from/supabase/#after-the-etl-fix-the-fk-references).
Save it as `scripts/etl/helpers.js` and `require` it from each
per-table ETL.

## Auth migration

Hasura doesn't store users — it validates JWTs against
`HASURA_GRAPHQL_JWT_SECRET`. dAvePi has its own `User` model.

### Two paths

1. **Keep the same JWT issuer.** If your Hasura JWTs are issued by a third-party (Auth0, Firebase, Clerk, your own auth service), point dAvePi at the same issuer. You'll need to map the source's `sub` claim into dAvePi's `req.user.user_id`. This requires customising `middleware/auth.js` to verify against the third-party's JWKS endpoint instead of `TOKEN_KEY`. Workable, not trivial.

2. **Migrate users into dAvePi's auth.** Re-create each user via the standard Supabase-style script, force-reset passwords, switch the frontend to `/login` and `/register`. The cleaner path for most teams.

For path 2, run the same `scripts/migrate-supabase-users.js`
shape from the Supabase guide — replace the source-specific user
list with whatever your Hasura backend has.

### Roles in the JWT

Hasura embeds roles as `x-hasura-allowed-roles` /
`x-hasura-default-role` in the JWT. dAvePi reads
`req.user.roles` (a plain string array) from the token's
payload. Update your JWT issuer to emit:

```json
{ "user_id": "<uid>", "roles": ["user", "admin"], "iat": ..., "exp": ... }
```

instead of the Hasura-shaped claim. The User model's `roles`
field is the source-of-truth; the JWT just carries the roles to
the runtime.

## Cutover checklist

- [ ] Each tracked table has a `schema/versions/v1/<resource>.js` file.
- [ ] Permission rules translated to `acl` blocks (and verified — write a few integration tests).
- [ ] Object / array relationships translated to `relations` map entries.
- [ ] Event triggers translated to schema `webhooks` blocks; receivers verify HMAC signatures.
- [ ] Actions reimplemented as custom routes in `index.js`.
- [ ] Cron / scheduled triggers wired to `node-cron` or your platform's scheduler.
- [ ] User records imported; password reset emails sent.
- [ ] JWT issuer emits `user_id` + `roles` claims (not Hasura-shaped claims).
- [ ] Per-table ETL run; FK rewrites done; `legacyId` columns dropped.
- [ ] Frontend `@apollo/client` queries against Hasura → typed dAvePi client or direct REST calls.
- [ ] Hasura instance archived after a cooling-off window.

## See also

- [Schema file shape](/reference/schema/)
- [ACL](/features/acl/)
- [Relations](/features/relations/)
- [Webhooks](/features/webhooks/)
- [dAvePi vs. Hasura](/compared-to/hasura/)
- [From Supabase](/migrate-from/supabase/) — the reference end-to-end walkthrough; the ETL + auth patterns there apply here too.
