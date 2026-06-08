---
title: From Strapi
description: Migrate from Strapi to dAvePi — content types → schema files, components → sub-schemas, draft/publish → state machine, plugins → custom routes.
---

Strapi optimises for content editors; dAvePi optimises for
developers and agents. If your Strapi project is actually a
developer-shaped backend that ended up in a CMS by accident,
the migration is straightforward. If non-developer content
editors are the primary admin users, **stay on Strapi** — its
editor UX is purpose-built for that audience and isn't worth
trading for the framework features dAvePi offers.

This guide assumes you've decided to move.

## What moves

| Strapi | dAvePi | Notes |
|--------|--------|-------|
| Content type (collection / single) | `schema/versions/v1/<resource>.js` | One file per content type. |
| Content type attributes | `fields[]` | Direct map, see table below. |
| Component | Embedded Mongoose sub-schema, or a separate collection | Components are reusable shape — sub-schema if always nested, separate collection if shared. |
| Dynamic zone | `Mixed` field with a discriminator, or a polymorphic relation | Dynamic zones don't map cleanly; usually rebuilt. |
| Draft / publish lifecycle | `state` field with a state machine | `draft → published → archived` with transitions. |
| Localisation (i18n) | `translations: { [locale]: ... }` sub-document, or per-locale resources | No native i18n; pick a pattern. |
| Permissions (roles + actions) | `acl.list` / `acl.write` / `acl.delete` + `field.acl.*` | Per-row → document; per-field → field ACL. `acl.write` covers cross-tenant update. |
| Users & Permissions plugin users | `User` model | Force password reset on cutover. |
| Lifecycle hooks (`beforeCreate`, etc.) | Custom routes (for before-events); webhook subscriptions (`POST /api/v1/webhooks`) or state-machine `onEnter` (for after-events) | Strapi's `before*` hooks are inline; dAvePi's equivalent is a custom route that intercepts before calling `Model.create`. Webhooks dispatch async with retry backoff. |
| Custom controllers / services / policies | Custom Express routes / helpers in `utils/` | Move the code out of Strapi's folder structure into the Node app's structure. |
| Plugins | Custom routes, helpers, or external services | Strapi plugins don't translate; rewrite per-plugin. |
| Media library | File fields (`type: 'File'`) + local / S3 driver | Each upload becomes a `FileMeta` sub-document on its owning record. |
| Internationalisation (locales) | Not built in | Model explicitly in your schema if needed. |

## Field-type mapping

| Strapi attribute | dAvePi | Notes |
|------------------|--------|-------|
| `string` | `String` | |
| `text` | `String` | Long-form; no length cap by default. |
| `richtext` | `String` | Store the HTML / markdown directly. |
| `email` | `String` + `match: /…/` | Or rely on the auth layer. |
| `password` | (don't migrate) | dAvePi only stores password hashes for the `User` model. |
| `integer` / `biginteger` / `decimal` / `float` | `Number` | Store cents for money. |
| `boolean` | `Boolean` | |
| `date` / `datetime` / `time` | `Date` | UTC. |
| `uid` (auto-slug) | `String` + a pre-save hook OR a `computed` field | Mongoose pre-save in a custom model file if you need the auto-derivation; or compute on read. |
| `json` | `Mixed` or a nested sub-schema | Prefer sub-schema if keys are stable. |
| `media` (single) | `type: 'File'` | |
| `media` (multi) | Sub-collection or multiple file fields | dAvePi doesn't have "array of files" natively. |
| `relation` (oneToOne / manyToOne) | `String` FK + `relations.<name> = belongsTo` | |
| `relation` (oneToMany / manyToMany) | Inverse `relations` entry + (for M2M) a join collection | M2M needs a `<a>_<b>` join collection with two FK columns. |
| `enumeration` | `String` + `enum: [...]` (or state machine) | |
| Component (single) | Nested sub-schema in the parent's `fields[]` | |
| Component (repeatable) | Array of sub-schemas: `{ name: 'items', type: [SubSchema] }` | |
| Dynamic zone | (rebuild) | Usually replaced by an explicit `kind` discriminator + per-kind fields. |

## Components → sub-schemas

Strapi components are reusable shapes you embed in content
types. The dAvePi equivalent is a sub-schema declared inline:

```js
// schema/versions/v1/article.js
const AuthorBlock = {
  name:    { type: String, required: true },
  bio:     { type: String },
  twitter: { type: String },
};

module.exports = {
  path: 'article',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'title',  type: String, required: true, searchable: true },
    { name: 'body',   type: String },
    // Single component → nested sub-schema
    { name: 'author', type: AuthorBlock },
    // Repeatable component → array of sub-schemas
    { name: 'callouts', type: [{
      kind:    { type: String, enum: ['note', 'warning', 'tip'] },
      body:    { type: String, required: true },
    }] },
  ],
};
```

If a component is shared across many content types, move it to
`schema/components/<name>.js` and `require` it from each schema
file.

## Draft / publish → state machine

Strapi's two-state draft/publish lifecycle is exactly what
dAvePi's state machine vocabulary handles:

```js
{
  name: 'status',
  type: String,
  stateMachine: {
    initial: 'draft',
    states: ['draft', 'published', 'archived'],
    transitions: {
      draft:     ['published', 'archived'],
      published: ['draft', 'archived'],     // unpublish or archive
      archived:  [],                        // terminal (or add 'draft' to allow un-archive)
    },
    onEnter: {
      published: async (record, ctx) => {
        // Fire when a record transitions into published.
        // ctx.req.log.info({ id: record._id }, 'article published');
      },
    },
  },
}
```

The state machine surfaces:

- A typed `transitionStatus(id, to)` method on the typed client.
- A `<resource>TransitionStatus(_id, to)` GraphQL mutation.
- An `availableTransitions.status` virtual on every read (UI can show only valid actions).
- Audit log entries on every transition.

[State machines](/features/state-machines/) covers the full
surface.

### Scheduled publishing

Strapi's scheduled-publish feature doesn't have a direct map.
Two patterns:

1. **Cron job in `index.js`** that scans for `status: 'draft'` records with a `publishAt: { $lte: new Date() }` field and runs the transition. ~15 LOC with `node-cron`.
2. **Workflow engine.** If scheduling is a major feature, use a job-queue library (BullMQ, Agenda) with a worker that calls the framework's state-transition route.

## Permissions → ACL

Strapi's Users & Permissions plugin (or RBAC in EE) is a
permissions matrix: roles × content types × actions
(`find`/`findOne`/`create`/`update`/`delete`). Each cell is
on / off.

The translation is mechanical:

| Strapi cell | dAvePi |
|-------------|--------|
| Public role × `find` on `Article` ON | Custom unauthenticated route (see PocketBase guide's "public read" pattern) |
| Authenticated role × `find`/`findOne` (default) | (default behaviour, tenant-scoped) |
| Specific role × `create`/`update` | Field-level `acl.create` / `acl.update` if column-scoped; or default if everyone-with-auth can write |
| Role × `delete` on `Article` ON only for admin | `acl.delete: ['admin']` on the schema |
| Role can see column X | `field.acl.read: [...roles]` |

If a role is purely "internal user, all their data," it's the
dAvePi default — no ACL block needed.

## Media library → file fields

Each Strapi media library entry maps to a `FileMeta` sub-document
on the owning record. Strapi stores files under `public/uploads/`
(local) or a configured S3 / Cloudinary bucket.

### Schema declaration

```js
{
  name: 'featuredImage',
  type: 'File',
  file: {
    maxBytes:   8 * 1024 * 1024,
    accept:     ['image/png', 'image/jpeg', 'image/webp'],
    storage:    's3',
    visibility: 'public',
  },
}
```

### Moving the blobs

For Strapi local uploads:

```bash
# Move Strapi's public/uploads to dAvePi's UPLOADS_DIR, restructured by tenant.
# Pre-built per-record map (built during ETL) is required.
node scripts/etl/relocate-strapi-uploads.js
```

A sketch of the script:

```js
// scripts/etl/relocate-strapi-uploads.js
require('dotenv').config();
const fs   = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Article = mongoose.model('article');

  const articles = await Article.find(
    { 'featuredImage.key': { $exists: true } },
    { userId: 1, _id: 1, featuredImage: 1, legacyImagePath: 1 },
  ).lean();

  for (const a of articles) {
    const src = path.join(process.env.STRAPI_UPLOADS_DIR, a.legacyImagePath);
    const destDir = path.join(process.env.UPLOADS_DIR, a.userId, 'featuredImage', a._id.toString());
    await fs.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, a.featuredImage.originalName);
    await fs.copyFile(src, dest);
    // Stamp the new key
    await Article.updateOne(
      { _id: a._id },
      { $set: { 'featuredImage.key': `${a.userId}/featuredImage/${a._id}/${a.featuredImage.originalName}` } },
    );
  }
  await mongoose.disconnect();
})();
```

For Strapi → S3 / S3 → S3 syncs, use `aws s3 sync` then update
the keys in a follow-up pass.

## The ETL template

Strapi's data lives in your configured DB (Postgres, MySQL,
SQLite, or Mongo). The Strapi shape adds JSON-encoded column
content for components and relations.

### From Postgres

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

  const pg = new Client({ connectionString: process.env.STRAPI_DB_URL });
  await pg.connect();

  let offset = 0;
  for (;;) {
    // Strapi tables are typically pluralised: 'articles', 'articles_components', etc.
    const { rows } = await pg.query(
      `SELECT * FROM articles ORDER BY id LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    );
    if (!rows.length) break;

    // Components live in a join table — fetch them per row.
    const ids = rows.map((r) => r.id);
    const { rows: components } = await pg.query(
      `SELECT * FROM articles_components WHERE article_id = ANY($1::int[])`, [ids],
    );

    const componentsByArticle = new Map();
    for (const c of components) {
      if (!componentsByArticle.has(c.article_id)) componentsByArticle.set(c.article_id, []);
      componentsByArticle.get(c.article_id).push(c);
    }

    const docs = rows.map((row) => {
      const cs = (componentsByArticle.get(row.id) || []);
      return {
        _id:        new mongoose.Types.ObjectId(),
        legacyId:   row.id,
        userId:     (userMap.get(row.author_id) || '').toString(),
        title:      row.title,
        body:       row.body,
        status:     row.published_at ? 'published' : 'draft',
        callouts:   cs.filter((c) => c.field === 'callouts').map((c) => ({
          kind:  c.kind,
          body:  c.body,
        })),
        createdAt:  row.created_at,
        updatedAt:  row.updated_at,
      };
    }).filter((d) => d.userId);

    if (docs.length) await Article.collection.insertMany(docs, { ordered: false });
    console.log(`offset=${offset} inserted=${docs.length}`);
    offset += BATCH;
  }

  await pg.end();
  await mongoose.disconnect();
})();
```

### From SQLite / MySQL

Same shape, different driver. For SQLite, swap `pg` for
`better-sqlite3`. For MySQL, swap for `mysql2`.

### From Mongo (Strapi on Mongo)

If you were already on Mongo, the migration is per-document
re-shape inside the same Mongo instance — copy rows from
`strapi.articles` to `davepi.article`, transforming the
component join tables into nested arrays in the same pass.

## Auth migration

Strapi's Users & Permissions plugin stores password hashes
(bcrypt-shaped, but different cost factor by default — Strapi
defaults to rounds=10 too in recent versions, which **happens to
match dAvePi**).

**You may be able to re-use the hashes if both sides are bcrypt
with the same cost factor.** Verify by inspecting a hash
from each:

```sh
$ # bcrypt hash format: $2a$10$...   ($2a$ = bcrypt, 10 = cost)
$ psql -c "SELECT password FROM up_users LIMIT 1" | head
```

If both are `$2a$10$...` (or `$2b$10$...`), you can copy the
hashes directly into dAvePi's `User.password` column and users
sign in with their existing passwords — no reset needed.

If they don't match (different cost, different variant, different
algorithm), fall back to the force-reset pattern from the
[Supabase guide](/migrate-from/supabase/#auth-migration).

## Plugins

Strapi plugins don't migrate. Per-plugin replacement strategy:

| Strapi plugin | dAvePi equivalent |
|---------------|-------------------|
| Email | `nodemailer` or a transactional email service called from `index.js` |
| Upload | Built in — `type: 'File'` field |
| Documentation | Built in — Swagger UI mounted on `/api-docs` |
| GraphQL | Built in |
| i18n | Build-your-own — `translations: { en: ..., fr: ... }` sub-document |
| Sentry / monitoring | `pino` → external log aggregator + the framework's Prometheus metrics (`METRICS_ENABLED=true`) |
| SEO | Custom Express routes for the public-facing surface |
| Search | Built in — `searchable: true` on a field |
| Custom field types | Open a PR; or model with `Mixed` for now |

## Cutover checklist

- [ ] Each content type has a `schema/versions/v1/<resource>.js` file.
- [ ] Components translated to sub-schemas.
- [ ] Dynamic zones rebuilt with explicit discriminators.
- [ ] Draft / publish replaced with a state machine.
- [ ] Permissions matrix translated to `acl` blocks.
- [ ] User records imported; password hashes re-used (if bcrypt-compatible) or reset.
- [ ] Media library moved; `FileMeta` sub-documents stamped.
- [ ] Lifecycle hooks reimplemented as custom routes or `onEnter` handlers.
- [ ] Plugins replaced one-by-one with the equivalents above.
- [ ] i18n strategy chosen (translations sub-doc, per-locale records, or back to Strapi).
- [ ] Frontend Strapi-shaped responses (`{ data: { attributes } }`) replaced with dAvePi's flat `{ _id, ...fields }` shape.

## See also

- [Schema file shape](/reference/schema/)
- [State machines](/features/state-machines/) — replace draft/publish.
- [ACL](/features/acl/)
- [File uploads](/features/files/)
- [dAvePi vs. Strapi](/compared-to/strapi/)
- [From Supabase](/migrate-from/supabase/) — the reference end-to-end walkthrough.
