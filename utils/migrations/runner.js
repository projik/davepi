const fs = require('fs');
const path = require('path');
const { acquireLock, releaseLock, ensureIndex } = require('./lock');

/**
 * Migration runner. Discovers migration files in MIGRATIONS_DIR
 * (default ./migrations), applies pending ones in lexical order,
 * and tracks completion in the `_migrations` collection so each
 * migration runs exactly once.
 *
 * Each migration file exports `{ description, up(db), down(db) }`.
 * Names are timestamped (`YYYY-MM-DD-HHmmss-<slug>.js`) so the
 * lexical sort matches the chronological intent.
 */

const DEFAULT_DIR = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.resolve('./migrations');

function listMigrationFiles(dir = DEFAULT_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

async function loadAppliedNames(db) {
  const coll = db.collection('_migrations');
  const docs = await coll.find({ name: { $ne: '__lock' } }).toArray();
  return new Set(docs.map((d) => d.name));
}

function migrationNameFromFile(file) {
  return path.basename(file, '.js');
}

async function status({ db, dir = DEFAULT_DIR } = {}) {
  const applied = await loadAppliedNames(db);
  const files = listMigrationFiles(dir);
  return files.map((file) => {
    const name = migrationNameFromFile(file);
    return { name, file, applied: applied.has(name) };
  });
}

async function migrateUp({ db, dir = DEFAULT_DIR, dry = false, log = console } = {}) {
  await ensureIndex(db);
  const owner = await acquireLock(db);
  if (!owner) {
    throw new Error('Could not acquire migration lock — another runner is in flight.');
  }
  try {
    const applied = await loadAppliedNames(db);
    const pending = listMigrationFiles(dir).filter(
      (f) => !applied.has(migrationNameFromFile(f))
    );
    const ran = [];
    for (const file of pending) {
      const full = path.resolve(dir, file);
      delete require.cache[require.resolve(full)];
      const m = require(full);
      const name = migrationNameFromFile(file);
      if (typeof m.up !== 'function') {
        throw new Error(`Migration ${name} does not export an up() function`);
      }
      log.info ? log.info({ name }, dry ? 'would apply' : 'applying') : log.log(`${dry ? 'would apply' : 'applying'} ${name}`);
      const t0 = Date.now();
      if (!dry) {
        await m.up(db);
        await db.collection('_migrations').insertOne({
          name,
          appliedAt: new Date(),
          durationMs: Date.now() - t0,
        });
      }
      ran.push({ name, durationMs: Date.now() - t0, dryRun: dry });
    }
    return ran;
  } finally {
    await releaseLock(db, owner);
  }
}

async function migrateDown({ db, dir = DEFAULT_DIR, dry = false, log = console } = {}) {
  await ensureIndex(db);
  const owner = await acquireLock(db);
  if (!owner) {
    throw new Error('Could not acquire migration lock — another runner is in flight.');
  }
  try {
    const coll = db.collection('_migrations');
    const last = await coll
      .find({ name: { $ne: '__lock' } })
      .sort({ appliedAt: -1 })
      .limit(1)
      .toArray();
    if (last.length === 0) {
      return null;
    }
    const target = last[0];
    const file = `${target.name}.js`;
    const full = path.resolve(dir, file);
    if (!fs.existsSync(full)) {
      throw new Error(
        `Cannot revert ${target.name}: migration file ${file} not found`
      );
    }
    delete require.cache[require.resolve(full)];
    const m = require(full);
    if (typeof m.down !== 'function') {
      throw new Error(`Migration ${target.name} does not export a down() function`);
    }
    log.info ? log.info({ name: target.name }, dry ? 'would revert' : 'reverting') : log.log(`${dry ? 'would revert' : 'reverting'} ${target.name}`);
    if (!dry) {
      await m.down(db);
      await coll.deleteOne({ name: target.name });
    }
    return { name: target.name, dryRun: dry };
  } finally {
    await releaseLock(db, owner);
  }
}

module.exports = {
  status,
  migrateUp,
  migrateDown,
  listMigrationFiles,
  migrationNameFromFile,
  DEFAULT_DIR,
};
