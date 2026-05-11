---
title: From Supabase
description: End-to-end migration from Supabase to dAvePi. Tables → schemas, RLS → ACL, auth.users → User model, Storage → file fields. ETL script template + worked example.
---

Supabase → dAvePi is the most common migration path because the
shapes are close: schema-driven, JWT auth, file storage, change
hooks. The translation isn't trivial — Postgres → Mongo, RLS →
ACL, and `auth.users` doesn't move in place — but each piece has
a direct counterpart.

This is the **reference end-to-end guide**. Other migrations
(Hasura, PocketBase, Strapi, Directus) follow the same shape;
this one is the most detailed because it covers the auth +
storage + RLS picture together.

## What moves

| Supabase | dAvePi | Notes |
|----------|--------|-------|
| `public.<table>` | `schema/versions/v1/<table>.js` | One file per table. |
| Column → type | `{ name, type }` in `fields[]` | Type mapping below. |
| `user_id uuid REFERENCES auth.users` | `userId: String` | Framework-stamped tenant column. |
| RLS policies (`USING (auth.uid() = user_id)`) | (default behaviour) | The owner-only pattern is dAvePi's default — no policy. |
| RLS with role check | `acl.list` / `acl.delete` / `field.acl.{read,create,update}` | Per-row → document ACL; per-column → field ACL. |
| `pg_graphql` GraphQL surface | Auto-generated GraphQL | Both expose the schema; query shape differs. |
| `auth.users` table | `User` model (`model/user.js`) | Force password reset on cutover. |
| Storage bucket | File field (`type: 'File'`) + S3 or local driver | One bucket → one schema using file fields, typically. |
| Database webhook | `webhooks: [{ event: '...', url: '...' }]` on the schema | Same idea, schema-declared. |
| Edge function | Custom Express route in `index.js` | Move HTTP-handler code out of Deno into Node. |
| `pgcrypto` `gen_random_uuid()` `_id`s | Mongo `ObjectId` `_id`s | All references need rewriting; the ETL script handles this. |

## Field-type mapping

| Postgres / Supabase | dAvePi | Notes |
|---------------------|--------|-------|
| `text`, `varchar`, `citext` | `String` | `citext` columns map to `String` + `lowercase: true` for case-insensitive matches. |
| `int2`, `int4`, `int8` | `Number` | Mongo stores doubles by default; for large `int8` values, see `NumberLong` if precision matters. |
| `numeric`, `decimal` | `Number` | **Store cents, not dollars** — `amountCents: Number` instead of floats. |
| `float4`, `float8` | `Number` | |
| `boolean` | `Boolean` | |
| `date`, `timestamp`, `timestamptz` | `Date` | dAvePi stores in UTC. |
| `uuid` | `String` | Mongo's `_id` is `ObjectId`. Keep the UUID in a column like `legacyId` for the cutover window if external systems reference it. |
| `jsonb` | `Mixed` or a nested sub-schema | Prefer a nested schema if the keys are stable. |
| `text[]` | `[String]` | Array fields are first-class in Mongo. |
| `enum` (Postgres enum type) | `String` with `enum: [...]` or a state machine | State machine if transitions are constrained. |
| Generated column | `computed: (r) => ...` | Pure function over the record. |
| Foreign key | `String` + `relations` map entry | See [Relations](/features/relations/). |
| Storage bucket file ref | `type: 'File'` + `file: { ... }` | See [File uploads](/features/files/). |

## Auth migration

`auth.users` doesn't move in place. Supabase uses scrypt for
password hashing; dAvePi uses bcrypt (rounds=10). The hashes
aren't interchangeable.

The **only correct move** is a one-time password reset on
cutover. Both endpoints are built in:

- `POST /auth/forgot-password` — email a reset token (single-use, hashed at rest, 1-hour TTL).
- `POST /auth/reset-password` — submit the token + new password.

### Re-creating users

```js
// scripts/migrate-supabase-users.js
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const mongoose = require('mongoose');
const User = require('davepi/model/user');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  let page = 1, perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    if (!data.users.length) break;

    const docs = await Promise.all(data.users.map(async (u) => ({
      _id: new mongoose.Types.ObjectId(),
      legacyId: u.id,
      email: u.email,
      first_name: u.user_metadata?.first_name || null,
      last_name: u.user_metadata?.last_name || null,
      // Bcrypt hash of random bytes: matches dAvePi's auth shape so
      // login attempts get a normal bcrypt.compare (which will fail
      // until the user completes the password-reset flow below).
      password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
      roles: u.app_metadata?.roles || ['user'],
    })));
    await User.collection.insertMany(docs, { ordered: false });

    console.log(`page ${page}: inserted ${docs.length}`);
    if (data.users.length < perPage) break;
    page++;
  }
  await mongoose.disconnect();
})();
```

`legacyId` is a temporary column. The ETL script (below) uses it
to rewrite Supabase `user_id` references to the new Mongo
`_id`s. Drop the column after cutover. The stub bcrypt hash is
intentionally unrecoverable — every user **must** complete the
password-reset flow below before they can log in.

### Triggering the bulk reset

After importing users, batch-send password-reset emails:

```js
// scripts/send-reset-emails.js
require('dotenv').config();
const mongoose = require('mongoose');
const fetch = require('node-fetch');
const User = require('davepi/model/user');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const users = await User.find({}, { email: 1 }).lean();

  for (const u of users) {
    const r = await fetch(`${process.env.API_BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: u.email }),
    });
    console.log(u.email, r.status);
    await new Promise((r) => setTimeout(r, 100));  // gentle throttle
  }
  await mongoose.disconnect();
})();
```

Pair this with a customised email body so users get a "we've
migrated to a new system — set your new password" message rather
than a generic reset. The subject and body are hardcoded in
`/auth/forgot-password` inside dAvePi's `app.js`; to customise,
fork the handler (e.g. mount your own at the same path *before*
`require('davepi')`, or patch `app.js` and re-deploy). The
underlying `sendMail` helper lives in `utils/mailer.js` and uses
SMTP if `SMTP_HOST` is set, otherwise logs the body to the
structured logger.

## RLS → ACL mapping

Supabase RLS is per-policy; dAvePi's ACL is per-schema. The
common patterns map cleanly:

### "User owns their rows" (the 90% case)

```sql
-- Supabase
create policy "Users can view their own deals"
  on deals for select
  using (auth.uid() = user_id);
create policy "Users can insert their own deals"
  on deals for insert
  with check (auth.uid() = user_id);
```

```js
// dAvePi (default — no acl block needed)
module.exports = {
  path: 'deal',
  fields: [
    { name: 'userId',  type: String, required: true },
    { name: 'title',   type: String, required: true },
    { name: 'amount',  type: Number },
  ],
};
```

`userId` is the tenant column; the framework injects
`userId: req.user.user_id` into every query. No ACL block
needed.

### "Admins can see everyone's rows"

```sql
-- Supabase
create policy "Admins can view all deals"
  on deals for select
  using (auth.jwt() ->> 'role' = 'admin');
```

```js
// dAvePi
module.exports = {
  path: 'deal',
  fields: [/* ... */],
  acl: {
    list:   ['admin'],   // admins bypass tenant scoping on reads
    delete: ['admin'],
  },
};
```

### "Hide salary column from non-HR"

```sql
-- Supabase: granular column permissions via GRANT or computed views
revoke select (salary) on employees from anon, authenticated;
grant  select (salary) on employees to hr;
```

```js
// dAvePi: per-field ACL
{
  name: 'salary',
  type: Number,
  acl: { read: ['admin', 'hr'], create: ['admin', 'hr'], update: ['admin', 'hr'] },
}
```

Without an overlapping role, the field is stripped from REST /
GraphQL / MCP responses and rejected on writes.

See [ACL](/features/acl/) for the full surface.

## Storage → file fields

Each Supabase bucket usually maps to a file field on a schema
(`avatars` bucket → `User.avatar`, `attachments` bucket →
`Deal.attachment`).

### Schema declaration

```js
{
  name: 'avatar',
  type: 'File',
  file: {
    maxBytes:   2 * 1024 * 1024,
    accept:     ['image/png', 'image/jpeg', 'image/webp'],
    storage:    's3',
    visibility: 'public',           // direct URL; private would issue signed URLs
  },
}
```

### Moving the blobs

For S3-backed Supabase Storage, the fastest path is
`aws s3 sync` from the Supabase bucket to your dAvePi bucket
(both are S3-compatible):

```bash
aws s3 sync \
  s3://supabase-bucket-id/avatars/ \
  s3://acme-davepi-uploads/avatars/ \
  --source-region <supabase-region> \
  --region <davepi-region>
```

For self-hosted Supabase using the local filesystem driver,
`rsync` the directory.

### Updating the metadata

After the blobs are in place, the ETL pass that imports each
record's row stamps the new `FileMeta` sub-document:

```js
// inside the per-row transform
out.avatar = {
  key:          `${out.userId}/avatar/${out._id}/${originalName}`,
  size:         row.avatar_size,
  contentType:  row.avatar_content_type,
  originalName: row.avatar_filename,
  uploadedAt:   row.avatar_uploaded_at || row.created_at,
};
// 'url' only present on visibility: 'public' — backfill via the fetch route or omit
```

The key shape `<userId>/<field>/<_id>/<filename>` is what
dAvePi's generated upload route uses for new uploads. Matching
that pattern keeps the future-state consistent.

If your Supabase keys don't match that pattern, you have two
options:

1. **Move the blobs to the dAvePi pattern** during the sync (rename via a script).
2. **Keep the legacy keys** in the `FileMeta.key` field. dAvePi reads the key as-is; only new uploads will follow the canonical pattern. Acceptable for cutover; clean up later if it bothers you.

## Edge functions → custom routes

Supabase Edge Functions are Deno; dAvePi runs Node. Code that
ran in an edge function moves into `index.js` after the
framework's `require('davepi')` line:

```js
// index.js (after `require('davepi')`)
const { auth, asyncHandler } = require('davepi');

app.post('/api/v1/checkout', auth(true), asyncHandler(async (req, res) => {
  // … your Stripe / business logic …
  res.json({ ok: true });
}));
```

`auth(true)` requires a valid JWT and exposes `req.user`.
`asyncHandler` plumbs rejections into the framework's terminal
error handler. Use `req.log` (Pino) instead of `console.log`.

## Database webhooks → subscription API

dAvePi's webhooks are runtime subscriptions, not schema config.
After a user authenticates, they (or a setup script) `POST` to
`/api/v1/webhooks` with the events they care about; the server
returns a freshly-generated `secret` (visible exactly once at
create time) and starts dispatching matching events to that URL.

```bash
curl -X POST https://api.example.com/api/v1/webhooks \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "events": ["deal.created", "deal.updated", "account.*"],
    "url": "https://hooks.zapier.com/..."
  }'
```

Patterns:

- **Exact**: `deal.created`
- **Resource wildcard**: `deal.*` (matches `deal.created`, `deal.updated`, `deal.deleted`, `deal.transitioned`)
- **Global wildcard**: `*`

Emitted event types are `<path>.created`, `<path>.updated`,
`<path>.deleted`, `<path>.transitioned` (state-machine moves).

### Delivery

Each delivery is a POST with headers:

```http
X-davepi-Signature: sha256=<hex>
X-davepi-Event:     deal.created
X-davepi-Delivery:  <uuid>
Content-Type:       application/json
```

`X-davepi-Signature` is `HMAC_SHA256(secret, rawBody)`,
hex-encoded. Receivers verify:

```js
const expected = 'sha256=' +
  crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
if (req.headers['x-davepi-signature'] !== expected) return res.status(401).end();
```

### Payload shape

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

`record` is present on single-record events (create / update /
transition). Bulk operations emit events with `filter` +
`numAffected` instead of `record` + `recordId`. No `before`
document is included today — if you need a diff, query the
record's `/history` (audit log) endpoint from the receiver.

### Retries

Deliveries are retried with backoff (1s, 5s, 30s, 5m, 1h).
After 10 consecutive failures the subscription auto-disables
(`active: false`) — re-enable manually after fixing the
receiver. **Receivers must be idempotent**: a delivery may
arrive more than once.

## The ETL template

The script below is the per-table template. Run it once per
table after the schema files are in place and the server has
been started once (so Mongoose creates the indexes).

```js
// scripts/etl/deals.js
require('dotenv').config();
const mongoose = require('mongoose');
const { Client } = require('pg');

const BATCH = 500;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Deal = mongoose.model('deal');                     // dAvePi-generated model
  const User = mongoose.model('user');

  // Build a Supabase auth.users.id → Mongo User._id map.
  const userMap = new Map(
    (await User.find({}, { legacyId: 1 }).lean()).map((u) => [u.legacyId, u._id]),
  );

  const pg = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await pg.connect();

  let offset = 0;
  for (;;) {
    const { rows } = await pg.query(
      `SELECT * FROM public.deals ORDER BY id LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    );
    if (!rows.length) break;

    const docs = rows.map((row) => ({
      _id:        new mongoose.Types.ObjectId(),
      legacyId:   row.id,
      userId:    (userMap.get(row.user_id) || '').toString(),  // tenant column
      title:      row.title,
      amountCents: Math.round(Number(row.amount) * 100),       // float → cents
      status:     row.status,
      createdAt:  row.created_at,
      updatedAt:  row.updated_at,
    })).filter((d) => d.userId);                               // drop orphans

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

Run with:

```bash
node scripts/etl/deals.js
```

### After the ETL: fix the FK references

If `deals.account_id` referenced `accounts.id`, you need a
second pass to rewrite those references to the new Mongo `_id`s.
First, a small helper that builds a `legacyId → _id` lookup for
any collection — the per-source guides reuse this shape:

```js
// scripts/etl/helpers.js
const mongoose = require('mongoose');

async function buildLegacyMap(modelName, legacyField = 'legacyId') {
  const Model = mongoose.model(modelName);
  const rows = await Model.find({}, { [legacyField]: 1 }).lean();
  return new Map(rows.map((r) => [String(r[legacyField]), r._id]));
}

module.exports = { buildLegacyMap };
```

Then the FK-rewrite pass:

```js
// scripts/etl/rewrite-fks.js
const { buildLegacyMap } = require('./helpers');
const accountMap = await buildLegacyMap('account');

const bulk = Deal.collection.initializeUnorderedBulkOp();
const cursor = Deal.find({}, { legacyId: 1, account_id_legacy: 1 }).cursor();
for await (const doc of cursor) {
  const newAcct = accountMap.get(doc.account_id_legacy);
  if (newAcct) {
    bulk.find({ _id: doc._id }).updateOne({ $set: { accountId: newAcct.toString() } });
  }
}
if (bulk.length) await bulk.execute();
```

After all FKs are rewritten, drop the `legacyId` /
`account_id_legacy` columns:

```js
await Deal.collection.updateMany({}, { $unset: { legacyId: '', account_id_legacy: '' } });
```

## Worked example: a deal-tracker app

Suppose the Supabase schema is:

```sql
create table accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  name        text not null,
  created_at  timestamptz default now()
);

create table deals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  account_id  uuid references accounts not null,
  title       text not null,
  amount      numeric(10, 2),
  status      text default 'open',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create policy "owner" on deals for select using (auth.uid() = user_id);
create policy "owner" on accounts for select using (auth.uid() = user_id);
```

The dAvePi schemas:

```js
// schema/versions/v1/account.js
module.exports = {
  path: 'account',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name',   type: String, required: true, searchable: true },
  ],
};

// schema/versions/v1/deal.js
module.exports = {
  path: 'deal',
  fields: [
    { name: 'userId',      type: String, required: true },
    { name: 'accountId',   type: String, required: true },
    { name: 'title',       type: String, required: true, searchable: true },
    { name: 'amountCents', type: Number, min: 0 },
    {
      name: 'status', type: String,
      stateMachine: {
        initial: 'open',
        states: ['open', 'won', 'lost'],
        transitions: { open: ['won', 'lost'], won: [], lost: ['open'] },
      },
    },
  ],
  relations: {
    account: { kind: 'belongsTo', resource: 'account', fk: 'accountId' },
  },
};
```

The migration plan:

1. Start dAvePi against an empty Mongo. Verify `/healthz` returns 200.
2. Run `scripts/migrate-supabase-users.js` (above) — every Supabase user gets a stub User record.
3. Run `scripts/etl/accounts.js` (using the template) — populates the `account` collection.
4. Run `scripts/etl/deals.js` (using the template, with `userMap` and `accountMap`) — populates `deal` and rewrites `account_id`.
5. Run `scripts/send-reset-emails.js` — every user gets a password-reset email.
6. **Read cutover.** Switch the frontend's read endpoints to dAvePi. Writes still go to Supabase.
7. Run the ETL nightly (or via a CDC stream from Postgres) to sync any new writes. The `legacyId` column in dAvePi makes the diff queryable.
8. **Write cutover.** Once the diff is small, freeze Supabase writes, run a final ETL pass, point writes at dAvePi. Tear down Supabase.

## Cutover checklist

- [ ] User records imported (with `legacyId`).
- [ ] Password reset email sent to every user.
- [ ] Per-table ETL run for every table; row counts match (within tolerance for in-flight writes).
- [ ] File blobs synced from Supabase Storage to S3 / local.
- [ ] `FileMeta` sub-documents stamped with new keys.
- [ ] FK rewrites complete; `legacyId` columns dropped (or kept for one cutover-window — your call).
- [ ] Frontend `supabase-js` calls replaced with dAvePi typed client (`davepi gen-client` output) or `fetch`.
- [ ] Realtime subscriptions replaced with polling or a webhook→websocket relay.
- [ ] Edge functions reimplemented as Express routes in `index.js`.
- [ ] Database webhooks reimplemented as schema `webhooks` blocks.
- [ ] DNS or load balancer switched to the dAvePi deployment.
- [ ] Supabase project archived or torn down only after a cooling-off window (~30 days).

## See also

- [Schema file shape](/reference/schema/) — the target shape.
- [Field options](/reference/fields/) — the full field reference.
- [ACL](/features/acl/) — document and field-level access control.
- [Relations](/features/relations/) — how `belongsTo` / `hasMany` are declared.
- [File uploads](/features/files/) — file field behaviour and storage drivers.
- [dAvePi vs. Supabase](/compared-to/supabase/) — feature comparison and "pick which" matrix.
