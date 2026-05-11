---
title: Migrations
description: One-shot data backfills for schema changes that need to touch existing rows — declared as JS files, run via the CLI.
---

Schema changes that **don't** need to touch existing rows (adding a
field with a default, adding an index, adding a computed field, adding
an aggregation) require nothing from you — restart the server and the
new schema loads. Mongoose builds indexes in the background; the
Apollo schema recomposes; the new MCP tools surface.

For changes that **do** need backfill (renaming a field, splitting a
field into two, computing a denormalised value across existing rows,
etc.) dAvePi has a small migration toolchain:
`utils/migrations/`.

## Anatomy

```js
// migrations/2026-05-01-add-account-region.js
module.exports = {
  name: '2026-05-01-add-account-region',
  description: 'Backfill account.region from country code.',

  async up({ models, log }) {
    const { Account } = models;
    const cursor = Account.find({ region: { $exists: false } }).cursor();
    let updated = 0;
    for await (const doc of cursor) {
      doc.region = inferRegion(doc.countryCode);
      await doc.save();
      updated++;
    }
    log.info({ updated }, 'backfill complete');
  },

  async down({ models }) {
    await models.Account.updateMany({}, { $unset: { region: '' } });
  },
};
```

| Key | Description |
|-----|-------------|
| `name` | Unique identifier. Convention: `YYYY-MM-DD-<short-slug>`. |
| `description` | One-liner shown by the CLI. |
| `up({ models, log, db })` | Forward migration. Receives Mongoose models for every loaded schema. |
| `down({ models, log, db })` | Reverse migration (best-effort). |

## Running

```bash
# Run all pending migrations against the configured Mongo.
npx davepi migrate up

# Run one specific migration.
npx davepi migrate up --name 2026-05-01-add-account-region

# Reverse the most recent migration.
npx davepi migrate down

# Show migration status.
npx davepi migrate status
```

The CLI:

1. Connects to Mongo using the same `MONGO_URI` as the app.
2. Loads the schema registry (so `models` carries every Mongoose model).
3. Reads the `migrations/` directory in alphabetical order.
4. Skips any migration whose `name` is already in the `_migrations` collection.
5. Wraps each `up` call in a recorded run — partial failures leave the row marked `failed` so the CLI knows to surface the error and not skip on the next run.

## Idempotency

Migrations are run-at-most-once: each successful run inserts a row
into `_migrations` keyed by `name`. The CLI refuses to run a
migration whose row already exists with status `succeeded`.

For migrations that need to be **resumable** (large backfills,
network blips), make `up` idempotent: scope the cursor to "only the
rows that haven't been touched yet" so a partial run can resume
without doubling-up.

```js
async up({ models }) {
  const cursor = models.Account.find({ region: { $exists: false } }).cursor();
  // ↑ idempotent: re-running picks up where it left off.
}
```

## Expand-migrate-contract

For changes that touch existing rows AND existing reads, the
standard pattern:

1. **Expand**: ship a code change that writes both shapes and reads either. The new field is optional.
2. **Migrate**: run the migration to backfill old rows into the new shape.
3. **Contract**: ship a code change that writes only the new shape and reads only the new shape. The old shape is dead.

Each step is a separate deploy. Each step works with the row state
left by the previous step, so partial rollouts don't break.

## Production execution

The migration CLI is a one-shot script — invoke it from your
deploy pipeline (between the expand and contract deploys) or from
a maintenance shell.

```yaml
# Example GitHub Actions step
- run: |
    npx davepi migrate up
  env:
    MONGO_URI: ${{ secrets.MONGO_URI }}
    NODE_ENV: production
```

It exits non-zero on any migration failure, so a CI pipeline will
halt the deploy if the backfill fails.

## What's not a migration

| Change | Action |
|--------|--------|
| Add a new field | Restart the server. Mongoose accepts missing fields as `undefined`; old reads work. |
| Add a default | Same — Mongoose stamps the default on new writes. Old rows stay missing the field unless you backfill. |
| Add an index | Mongoose builds it in the background at boot. Use the [migration runner](#anatomy) only if you need to drop an old index first. |
| Add an aggregation | Restart. The aggregation is computed live; no backfill needed. |
| Add a state machine to an existing field | The framework will refuse to compute `availableTransitions` for rows whose current value isn't in `states[]`. Use a migration to coerce old rows to a known state. |
| Rename a field | Migration. Rename in the schema, then run a migration that copies values from the old key to the new and unsets the old. Use expand-migrate-contract. |

## See also

- [Deployment](/operations/deployment/) — how migrations slot into a deploy pipeline.
- [Backup & retention](/operations/backup/) — keeping a snapshot before a destructive migration.
