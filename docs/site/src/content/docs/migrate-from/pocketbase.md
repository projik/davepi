---
title: From PocketBase
description: Migrate from PocketBase to dAvePi — collections → schema files, API rules → ACL, SQLite dump → Mongo ETL, WebSockets → webhooks.
---

PocketBase and dAvePi share the most DNA: both are schema-driven,
both auto-generate CRUD against a single source of truth. The
move is structurally the simplest of the five migrations — the
collection model maps almost 1:1 to dAvePi's schema files. The
gotchas are around realtime subscriptions, the single-binary
deploy posture, and the admin UI.

This guide is shorter than the Supabase walkthrough because the
shapes line up; the heavy lifting is in the data ETL from
SQLite to Mongo.

## What moves

| PocketBase | dAvePi | Notes |
|------------|--------|-------|
| Collection | `schema/versions/v1/<name>.js` | One file per collection. |
| Collection field | `{ name, type }` in `fields[]` | Direct map, see table below. |
| `id` (15-char random) | Mongo `_id: ObjectId` | All FKs rewritten in ETL; keep `legacyId` for the cutover window. |
| `created` / `updated` | `createdAt` / `updatedAt` | Set automatically by Mongoose's `timestamps: true` (default). |
| API rule (per CRUD verb) | `acl.list` / `acl.write` / `acl.delete` + field-level `acl` | Per-row → document ACL (`write` = cross-tenant update); per-column → field ACL. |
| `users` system collection | `User` model (`model/user.js`) | Force password reset on cutover. |
| Auth tokens | JWT + refresh (dAvePi-issued) | Tokens don't migrate. Users re-login (or reset password). |
| OAuth providers | Build your own | dAvePi ships email/password + JWT. |
| Realtime `subscribe()` | Webhook subscription (`POST /api/v1/webhooks`) | Push → pull-via-webhook OR webhook→websocket relay. |
| File field | `type: 'File'` + `file: { ... }` | Local or S3 storage. |
| JS hooks (`onRecordBeforeCreate`, etc.) | Webhook subscriptions for after-events; custom routes for before-events | PocketBase's `before*` hooks are inline; dAvePi's equivalent is a custom route that handles its own logic before calling `Model.create`. |
| Admin UI | Refine-based admin SPA | Both polished; PocketBase's is the killer feature, dAvePi's is auto-rendered from `_describe`. |

## Field-type mapping

| PocketBase | dAvePi | Notes |
|------------|--------|-------|
| `text` | `String` | |
| `email` | `String` + `match: /…/` | Or just `String` if validation happens at the auth layer. |
| `url` | `String` + `match: /^https?:\/\/.../` | |
| `number` | `Number` | |
| `bool` | `Boolean` | |
| `date` | `Date` | |
| `select` (single) | `String` + `enum: [...]` | Or a state machine if transitions are constrained. |
| `select` (multi) | `[String]` + `enum: [...]` | Mongoose validates each array entry against the enum. |
| `json` | `Mixed` or a nested sub-schema | Prefer a sub-schema if keys are stable. |
| `file` (single) | `type: 'File'` | |
| `file` (multi) | A sub-document collection, or split into multiple file fields | dAvePi doesn't have a native "array of files" field today; either model each upload as its own row in an `attachment` collection, or declare separate file fields. |
| `relation` (single) | `String` (the FK) + `relations.<name> = { kind: 'belongsTo', resource, fk }` | |
| `relation` (multi) | `[String]` (FK array) + a `relations` entry with `kind: 'hasMany'` from the other side | dAvePi prefers the inverse — define `hasMany` on the parent, not a back-reference array. |
| `editor` (rich text) | `String` | Treat as opaque HTML / markdown. |

## API rules → ACL

PocketBase has five API rules per collection — `listRule`,
`viewRule`, `createRule`, `updateRule`, `deleteRule` — each a
filter expression that evaluates per request.

### Owner-only (the default 90% case)

```
# PocketBase listRule / viewRule
@request.auth.id != "" && @request.auth.id = user.id
```

```js
// dAvePi: default behaviour with userId column
module.exports = {
  path: 'note',
  fields: [
    { name: 'userId', type: String, required: true },
    /* ... */
  ],
  // No acl block — tenant scoping is automatic.
};
```

### Public read, authenticated write

```
# PocketBase
listRule:   ""                                # everyone
viewRule:   ""
createRule: "@request.auth.id != \"\""
updateRule: "@request.auth.id = user.id"
deleteRule: "@request.auth.id = user.id"
```

This needs custom handling — dAvePi's default surface is
auth-required. For "public reads, authed writes," declare a
custom route that doesn't use `auth(true)`:

```js
// index.js (after `require('davepi')`)
const Post = mongoose.model('post');

app.get('/api/v1/public/posts', asyncHandler(async (req, res) => {
  // No auth — anyone can read.
  const docs = await Post.find({ status: 'published' }).limit(50).lean();
  res.json(docs);
}));
```

The auto-generated `/api/v1/post/*` routes still require auth;
the public route is an additional surface. Mounting it before
the `schemas.forEach` loop keeps the auth-required default for
mutations.

### Role-gated operations

```
# PocketBase
deleteRule: "@request.auth.role = 'admin'"
```

```js
// dAvePi
{
  path: 'post',
  fields: [/* ... */],
  acl: { delete: ['admin'] },
}
```

### Column-level access

PocketBase doesn't have native column-level rules; you'd put
the protected column on a separate collection. dAvePi's
field-level ACL is more direct:

```js
{
  name: 'internalNotes',
  type: String,
  acl: { read: ['admin'], create: ['admin'], update: ['admin'] },
}
```

## Realtime → webhook subscriptions (or relay)

PocketBase's WebSocket subscriptions:

```js
pb.collection('messages').subscribe('*', (e) => {
  console.log(e.action, e.record);
});
```

dAvePi doesn't push over WebSockets. It does have subscription
webhooks — `POST /api/v1/webhooks` registers a URL + event
pattern, the framework dispatches matching events to it. Three
options, in descending order of "matches the source behaviour":

### 1. Webhook → WebSocket relay

Subscribe a tiny relay service (Cloudflare Worker, Fly app,
~50 LOC) to dAvePi:

```bash
curl -X POST https://api.example.com/api/v1/webhooks \
  -H "authorization: Bearer $TOKEN" \
  -d '{ "events": ["message.*"], "url": "https://relay.example.com/in" }'
```

The relay:

- accepts webhook deliveries from dAvePi (verifying `X-davepi-Signature`),
- holds WebSocket connections from your frontends,
- forwards each delivered event (`{ type, recordId, record, ... }`) to the connected sockets.

Frontend code changes from `pb.collection(...).subscribe()` to
`new WebSocket('wss://relay.example.com/messages')`. The relay
is stateless — drop it, redeploy, sockets reconnect. Note that
dAvePi retries failed deliveries (1s / 5s / 30s / 5m / 1h);
your relay must be idempotent or accept "the same event might
arrive twice."

### 2. Polling

For lower-velocity changes (todo lists, dashboards), polling
every few seconds is fine and removes the realtime
infrastructure entirely. The typed client supports query
parameters; just wrap `setInterval(fetch...)` around it.

### 3. Server-Sent Events bridge

A custom Express route in `index.js` that subscribes to webhook
events server-side and emits SSE to connected browsers.
Simpler than a WebSocket relay if your frontend only needs
server → client push.

## File migration

Each PocketBase file field becomes a `type: 'File'` field in
dAvePi. The on-disk paths differ; the metadata fields do too.

### Schema declaration

```js
// dAvePi
{
  name: 'avatar',
  type: 'File',
  file: {
    maxBytes:   3 * 1024 * 1024,
    accept:     ['image/png', 'image/jpeg'],
    storage:    's3',           // or 'local'
    visibility: 'public',
  },
}
```

### Moving the blobs

PocketBase stores uploads under
`pb_data/storage/<collection_id>/<record_id>/<file_name>`.
Copy the blob tree to your dAvePi storage backend, transforming
the path layout to dAvePi's
`<userId>/<field>/<recordId>/<filename>`:

```bash
# Local → local
cd /opt/davepi/uploads
find /opt/pocketbase/pb_data/storage -type f | while read src; do
  # Adjust this path parser to your case; it's PocketBase-specific.
  collection_id=$(basename "$(dirname "$(dirname "$src")")")
  record_id=$(basename "$(dirname "$src")")
  fname=$(basename "$src")
  # Look up the userId for this record from the ETL output (e.g. via a sidecar JSON).
  user_id=$(jq -r ".[\"$record_id\"]" /tmp/user-map.json)
  dest="./$user_id/avatar/$record_id/$fname"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
done
```

(`/tmp/user-map.json` is built during the ETL — a `recordId →
userId` lookup table.)

For S3, swap the `cp` for `aws s3 cp`.

### Stamping the FileMeta

The ETL transform writes the file metadata sub-document:

```js
// inside the per-row transform
if (row.avatar) {
  out.avatar = {
    key:          `${out.userId}/avatar/${out._id}/${row.avatar}`,
    size:         row.avatar_size || 0,
    contentType:  row.avatar_content_type || 'application/octet-stream',
    originalName: row.avatar,
    uploadedAt:   row.created,
  };
}
```

## The ETL template

Two paths into PocketBase's data: the `pb_data/data.db` SQLite
file (the canonical store), or `pb admin export` (JSON dump).
JSON is simpler if you have shell access; SQLite is faster for
large datasets.

### SQLite → Mongo

```js
// scripts/etl/messages.js
require('dotenv').config();
const mongoose = require('mongoose');
const Database = require('better-sqlite3');

const BATCH = 500;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Message = mongoose.model('message');

  const userMap = new Map(
    (await mongoose.model('user').find({}, { legacyId: 1 }).lean())
      .map((u) => [u.legacyId, u._id]),
  );

  const db = new Database(process.env.POCKETBASE_DB_PATH, { readonly: true });
  const stmt = db.prepare(`SELECT * FROM messages ORDER BY created LIMIT ? OFFSET ?`);

  let offset = 0;
  for (;;) {
    const rows = stmt.all(BATCH, offset);
    if (!rows.length) break;

    const docs = rows.map((row) => ({
      _id:        new mongoose.Types.ObjectId(),
      legacyId:   row.id,
      userId:    (userMap.get(row.user) || '').toString(),
      body:       row.body,
      createdAt:  new Date(row.created),
      updatedAt:  new Date(row.updated),
    })).filter((d) => d.userId);

    if (docs.length) await Message.collection.insertMany(docs, { ordered: false });
    console.log(`offset=${offset} inserted=${docs.length}`);
    offset += BATCH;
  }

  db.close();
  await mongoose.disconnect();
})();
```

### JSON dump → Mongo

If you used `pb admin export`:

```js
// scripts/etl/messages-from-json.js
require('dotenv').config();
const fs   = require('fs');
const mongoose = require('mongoose');
const { buildLegacyMap } = require('./helpers');   // defined in the Supabase guide

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Message = mongoose.model('message');
  const userMap = await buildLegacyMap('user');

  const rows = JSON.parse(fs.readFileSync(process.env.PB_DUMP_PATH, 'utf8')).messages;

  const docs = rows.map((row) => ({
    _id:       new mongoose.Types.ObjectId(),
    legacyId:  row.id,
    userId:    (userMap.get(row.user) || '').toString(),
    body:      row.body,
    createdAt: new Date(row.created),
    updatedAt: new Date(row.updated),
  })).filter((d) => d.userId);

  if (docs.length) await Message.collection.insertMany(docs, { ordered: false });
  console.log(`inserted ${docs.length}`);

  await mongoose.disconnect();
})();
```

### After the per-table ETLs

Run an FK-rewrite pass like the one in the
[Supabase guide](/migrate-from/supabase/#after-the-etl-fix-the-fk-references):
walk each collection, look up the legacy FK in the relevant
map, write the new `_id`.

## Auth migration

PocketBase's `users` collection (or any `auth` collection)
stores password hashes that don't move to dAvePi's bcrypt. The
flow is identical to the Supabase guide:

1. Import each PocketBase user to dAvePi's `User` model with a `legacyId` and a stub password.
2. Map roles: `pb.collection('users').authViaOAuth2(...)` users keep their `role` column, which translates to `User.roles: ['user']` by default — override if you'd been using a `role` field.
3. Send password-reset emails via `/auth/forgot-password` (bulk script in the Supabase guide).
4. Users log in via the dAvePi-issued JWT going forward.

If you'd been using OAuth providers (Google, GitHub, etc.), the
sign-in flow needs replacing — dAvePi doesn't ship an OAuth
client. Either build one or use a third-party (Auth0, Clerk,
WorkOS) that issues JWTs your dAvePi server accepts (requires
customising `middleware/auth.js`).

## Cutover checklist

- [ ] Each PocketBase collection has a `schema/versions/v1/<name>.js` file.
- [ ] API rules translated to `acl` blocks.
- [ ] Relations declared on both sides where needed.
- [ ] WebSocket subscribers migrated to webhooks → relay, polling, or SSE.
- [ ] File blobs moved to the dAvePi storage backend with the canonical key shape.
- [ ] `FileMeta` sub-documents stamped in the ETL pass.
- [ ] User records imported; bulk password reset emails sent.
- [ ] OAuth providers replaced (if used).
- [ ] PocketBase JS hooks reimplemented as webhook subscriptions (post-events) or custom routes (pre-events).
- [ ] Frontend PocketBase SDK (`pocketbase` npm package) calls replaced with the dAvePi typed client.
- [ ] Single-binary deploy retired in favour of the dAvePi Node + Mongo stack.

## See also

- [Schema file shape](/reference/schema/)
- [ACL](/features/acl/)
- [Webhooks](/features/webhooks/)
- [File uploads](/features/files/)
- [dAvePi vs. PocketBase](/compared-to/pocketbase/)
- [From Supabase](/migrate-from/supabase/) — the most detailed end-to-end walkthrough; auth + cutover patterns apply identically.
