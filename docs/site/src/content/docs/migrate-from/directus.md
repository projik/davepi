---
title: From Directus
description: Migrate from Directus to dAvePi — collections → schema files, permissions → ACL, Flows → state-machine onEnter + webhooks, file assets → file fields.
---

Directus's defining feature is "point at an existing SQL
database, get an admin + API surface for free." If you've kept
the existing database (Rails app, legacy reporting warehouse,
etc.) and Directus is just the admin layer, **stay on
Directus** — dAvePi can't do "introspect a database I didn't
build," and rewriting the schema as code costs more than the
admin migration saves.

This guide assumes the data shape is yours to redefine — you
built the Directus collections fresh and you're ready to commit
them to schema files.

## What moves

| Directus | dAvePi | Notes |
|----------|--------|-------|
| Collection | `schema/versions/v1/<resource>.js` | One file per collection. |
| Field | `{ name, type }` in `fields[]` | See type table below. |
| M2O / O2M / M2M relation | `relations` map entry on each schema | M2M needs a join collection (`<a>_<b>` with two FK columns). |
| Role + collection policy | `acl.list` / `acl.delete` on the schema | Per-row → document ACL. |
| Role + field permission | `field.acl.{read,create,update}` | Per-column → field ACL. |
| Activity log | Audit log (`audit: true`, default) | dAvePi's audit log is automatic; queryable via `history_<path>` MCP tool. |
| Revisions | Audit log diff entries | Diffs at field level; `/api/v1/<path>/:id/history`. |
| Soft delete (per-collection setting) | Default — every schema is soft-delete-capable | `restore_<path>` MCP tool included. |
| Files & assets | `type: 'File'` field + `file: { ... }` | Local or S3. |
| Asset transforms | Build a custom route or run a service in front | dAvePi doesn't transform images. |
| Flow (visual automation) | State-machine `onEnter` + outbound webhooks + custom routes | Code instead of visual; covered below. |
| Webhook (Directus) | Webhook subscription (`POST /api/v1/webhooks`) | Per-tenant subscriptions registered at runtime, not schema config. |
| Hook (script) | Custom Express route, state-machine `onEnter`, or webhook subscription | Depends on whether it's pre/post and what trigger. |
| Custom field interface (admin UI) | (no map — admin SPA is auto-rendered) | If you customised the admin heavily, the SPA route is the right surface — write a custom React component for the Refine admin. |
| Auth (local) | `User` model + JWT | Force password reset on cutover. |
| Auth (SSO / SAML / OAuth) | Build-your-own | dAvePi ships JWT + email/password + reset. |

## Field-type mapping

| Directus type | dAvePi | Notes |
|---------------|--------|-------|
| `string` / `text` | `String` | |
| `integer` / `bigInteger` / `decimal` / `float` | `Number` | Cents for money. |
| `boolean` | `Boolean` | |
| `date` / `datetime` / `time` | `Date` | UTC. |
| `json` | `Mixed` or a nested sub-schema | |
| `uuid` | `String` | Mongo `_id` is `ObjectId`; keep UUIDs in `legacyId`. |
| `csv` (Directus) | `[String]` | |
| `m2o` | `String` FK + `relations.<name> = belongsTo` | |
| `o2m` | (inverse) `String` FK on the child + `relations.<name> = hasMany` on the parent | |
| `m2m` | Join collection with two FK columns + `relations.<name> = hasMany` on each side | dAvePi doesn't have native M2M; the join collection is the standard pattern. |
| `file` | `type: 'File'` | |
| `alias` (computed) | `computed: (r) => ...` | |
| `hash` (one-way crypto hash) | `String` (store the hash; no special type) | |

## Permissions → ACL

Directus's permission editor is a matrix of role × collection ×
action (read / create / update / delete / share). Each cell can
have a row filter (`{ "user_created": "$CURRENT_USER" }`) and a
column-allow list.

### Owner-only (default)

```json
// Directus
{
  "role": "user",
  "collection": "notes",
  "action": "read",
  "permissions": { "user_created": { "_eq": "$CURRENT_USER" } }
}
```

```js
// dAvePi: default behaviour with userId column
module.exports = {
  path: 'note',
  fields: [
    { name: 'userId', type: String, required: true },
    /* ... */
  ],
};
```

### Cross-tenant for admin

```json
// Directus: admin role has no permission filter
```

```js
// dAvePi
{
  path: 'note',
  fields: [/* ... */],
  acl: { list: ['admin'], delete: ['admin'] },
}
```

### Column-level read

```json
// Directus
{
  "role": "user",
  "collection": "employees",
  "action": "read",
  "fields": ["id", "first_name", "last_name", "email"]   // 'salary' excluded
}
```

```js
{
  name: 'salary',
  type: Number,
  acl: { read: ['admin', 'hr'], create: ['admin', 'hr'], update: ['admin', 'hr'] },
}
```

## Relations

```js
// schema/versions/v1/article.js
relations: {
  author: { kind: 'belongsTo', resource: 'user', fk: 'authorId' },
},

// schema/versions/v1/user.js  -- if you've extended the User model into a dAvePi schema
relations: {
  articles: { kind: 'hasMany', resource: 'article', fk: 'authorId' },
},
```

Many-to-many through a join collection:

```js
// schema/versions/v1/article_tag.js — the join
module.exports = {
  path: 'articleTag',
  fields: [
    { name: 'userId',    type: String, required: true },
    { name: 'articleId', type: String, required: true },
    { name: 'tagId',     type: String, required: true },
  ],
  compositeIndex: [{ userId: 1, articleId: 1, tagId: 1 }],
};

// article.js
relations: {
  tags: { kind: 'hasMany', resource: 'articleTag', fk: 'articleId' },
},
```

## Flows → onEnter + webhooks + cron

Directus Flows are visual: an event trigger feeds into a chain of
operations (run script, send email, hit webhook, update record,
etc.). dAvePi's equivalent is code-driven and split by trigger:

| Directus Flow trigger | dAvePi |
|-----------------------|--------|
| **Event** (create / update / delete on collection) | Webhook subscription: `POST /api/v1/webhooks` with `{ events: ['deal.*'], url }` |
| **State transition** | `stateMachine.onEnter['stateName']: async (record, ctx) => ...` |
| **Manual** (button in admin) | Custom Express route triggered from an admin SPA action |
| **Schedule** (cron) | `node-cron` in `index.js`, or your platform's scheduler |
| **Webhook** (incoming HTTP) | Custom Express route in `index.js` |

The Flow operations themselves (the chain) become regular JS:

| Flow operation | JS replacement |
|----------------|----------------|
| `request` (HTTP call) | `fetch(...)` |
| `notification` (email / Slack) | `nodemailer` + your Slack webhook |
| `item-create` / `item-update` / `item-delete` | `Model.create(...)`, `Model.findOneAndUpdate(...)`, etc. |
| `condition` | `if (...) return;` |
| `transform` | inline transform in the handler |
| `exec` (run JS) | the JS itself, in the same handler |
| `log` | `req.log.info(...)` |

A worked example:

```
Directus Flow:
  trigger: event item.create on `deal`
  ops:
    1. condition: deal.amount > 100000
    2. notification: send Slack message to #sales
    3. item-update: set deal.priority = 'high'
```

becomes:

```bash
# One-time setup: register a webhook subscription against the running server.
curl -X POST https://api.example.com/api/v1/webhooks \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{ "events": ["deal.created"], "url": "https://example.com/deals-on-create" }'
# Response includes a `secret`. Stash it — it's shown only once.
```

```js
// services/deals-on-create.js (a Cloudflare Worker, Fly app, or whatever's receiving the webhook)
export default {
  async fetch(req) {
    const body = await req.json();              // payload: { type, recordId, record, userId, deliveredAt, ... }
    const record = body.record || {};
    if (record.amountCents > 10_000_000) {
      await fetch(process.env.SLACK_WEBHOOK, {
        method: 'POST',
        body: JSON.stringify({ text: `High-value deal: ${record.title}` }),
      });
      // Apply the priority update via dAvePi REST
      await fetch(`${process.env.DAVEPI_API}/api/v1/deal/${body.recordId}`, {
        method: 'PUT',
        headers: { 'authorization': `Bearer ${process.env.SERVICE_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ priority: 'high' }),
      });
    }
    return new Response(null, { status: 204 });
  },
};
```

If the Flow doesn't need to live elsewhere, fold it into the
dAvePi process as a state-machine `onEnter` or a webhook
receiver mounted on the same Express app:

```js
// index.js (after require('davepi'))
app.post('/webhooks/deals-on-create', express.json(), asyncHandler(async (req, res) => {
  // verify HMAC signature, then run the same logic inline
  res.status(204).end();
}));
```

## File migration

Directus stores files in `directus_files` with metadata, and the
blob in your configured storage adapter (local, S3, etc.).

### Schema declaration

Each Directus collection field pointing at `directus_files`
becomes a file field on the dAvePi schema:

```js
{
  name: 'attachment',
  type: 'File',
  file: {
    maxBytes: 25 * 1024 * 1024,
    accept:   ['application/pdf', 'image/png', 'image/jpeg'],
    storage:  's3',
    visibility: 'private',
  },
}
```

### Moving the blobs

For Directus on local storage:

```bash
rsync -av /opt/directus/uploads/ /opt/davepi/uploads-staging/
```

Then a script that walks each owning record, reads the original
Directus file UUID, finds the source blob, and copies it to
`<userId>/<field>/<recordId>/<filename>` under `UPLOADS_DIR`.

For Directus on S3:

```bash
aws s3 sync \
  s3://directus-bucket/uploads/ \
  s3://acme-davepi-uploads-staging/ \
  --source-region <directus-region> \
  --region <davepi-region>
```

Then the same record-walking script, with `aws s3 cp` instead of
local file ops.

The `FileMeta` sub-document gets stamped in the same ETL pass
that imports the record — see the
[Supabase walkthrough](/migrate-from/supabase/#updating-the-metadata).

### Asset transforms

Directus supports on-the-fly image transforms (`?width=...&format=webp`).
dAvePi doesn't. Three options:

1. **Pre-transform at upload.** Run `sharp` in a state-machine `onEnter` or a custom upload route; write multiple variants.
2. **Transform service in front.** Cloudflare Image Resizing, imgproxy, Thumbor. Point at the public S3 URL.
3. **Don't transform.** If your transforms are limited (just thumbnails), pre-generate them at upload.

## The ETL template

Directus is most commonly on Postgres. Same shape as the
Hasura / Supabase ETLs:

```js
// scripts/etl/articles.js
require('dotenv').config();
const mongoose = require('mongoose');
const { Client } = require('pg');
const { buildLegacyMap } = require('./helpers');   // defined in the Supabase guide

const BATCH = 500;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Article = mongoose.model('article');
  const userMap = await buildLegacyMap('user');

  const pg = new Client({ connectionString: process.env.DIRECTUS_DB_URL });
  await pg.connect();

  let offset = 0;
  for (;;) {
    const { rows } = await pg.query(
      `SELECT * FROM articles ORDER BY id LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    );
    if (!rows.length) break;

    const docs = rows.map((row) => ({
      _id:        new mongoose.Types.ObjectId(),
      legacyId:   row.id,
      userId:     (userMap.get(row.user_created) || '').toString(),
      title:      row.title,
      body:       row.body,
      status:     row.status,                  // Directus has its own status column
      createdAt:  row.date_created,
      updatedAt:  row.date_updated,
    })).filter((d) => d.userId);

    if (docs.length) await Article.collection.insertMany(docs, { ordered: false });
    console.log(`offset=${offset} inserted=${docs.length}`);
    offset += BATCH;
  }

  await pg.end();
  await mongoose.disconnect();
})();
```

`buildLegacyMap` is the helper from the
[Supabase guide](/migrate-from/supabase/#after-the-etl-fix-the-fk-references).
Save it as `scripts/etl/helpers.js` and `require` it from each
per-table ETL.

## Auth migration

Directus stores users in `directus_users` with Argon2id hashes
(the default in recent versions). Argon2 hashes don't migrate
to dAvePi's bcrypt.

Same force-reset pattern as the
[Supabase guide](/migrate-from/supabase/#auth-migration):

1. Import each Directus user with a `legacyId` and stub password.
2. Map Directus roles to dAvePi `User.roles`. The Directus `admin` role becomes `roles: ['admin']`; everyone else gets the default `['user']` (or a per-role mapping you decide).
3. Bulk-send password-reset emails via `/auth/forgot-password`.

### SSO

If your Directus uses SAML / OIDC / OAuth providers, dAvePi
doesn't have an out-of-box equivalent. Options:

- **Keep Directus for auth.** Have dAvePi accept the same JWTs Directus issues (requires customising `middleware/auth.js`).
- **Move to a third-party identity provider.** Auth0, Clerk, WorkOS — issue JWTs your dAvePi server accepts.
- **Force-migrate to local auth.** Email/password reset. Smallest change to dAvePi, biggest user-facing disruption.

## Cutover checklist

- [ ] Each Directus collection has a `schema/versions/v1/<resource>.js` file.
- [ ] Relations declared (with join collections for M2M).
- [ ] Permission rules translated to `acl` blocks.
- [ ] Flows decomposed into webhooks, `onEnter` handlers, and custom routes.
- [ ] Files moved to dAvePi storage backend; `FileMeta` sub-documents stamped.
- [ ] Asset transforms replaced (pre-transform / external service / pre-generated variants).
- [ ] User records imported; bulk password reset emails sent.
- [ ] SSO path decided (keep Directus / third-party IDP / local auth).
- [ ] Frontend `@directus/sdk` calls replaced with dAvePi typed client.
- [ ] Activity log queries reshaped to `_describe` + `history_<path>` MCP tool.
- [ ] Directus instance archived after a cooling-off window.

## See also

- [Schema file shape](/reference/schema/)
- [ACL](/features/acl/)
- [State machines](/features/state-machines/) — Flow replacement target.
- [Webhooks](/features/webhooks/)
- [Audit log](/features/audit/) — Activity log replacement.
- [dAvePi vs. Directus](/compared-to/directus/)
- [From Supabase](/migrate-from/supabase/) — the most detailed end-to-end walkthrough; auth + ETL patterns apply identically.
