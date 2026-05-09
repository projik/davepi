const fs = require('fs');
const os = require('os');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

const { diffVersions, formatDiff } = require('../utils/migrations/diff');
const { writeScaffold, scaffoldFromDiff } = require('../utils/migrations/scaffold');
const {
  status,
  migrateUp,
  migrateDown,
} = require('../utils/migrations/runner');
const { acquireLock, releaseLock } = require('../utils/migrations/lock');

let mongo;
let client;
let db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('davepi-migrations-test');
}, 60000);

afterAll(async () => {
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

afterEach(async () => {
  // Drop everything between tests so applied-state doesn't bleed.
  const collections = await db.collections();
  await Promise.all(collections.map((c) => c.drop().catch(() => {})));
});

const mkdtemp = (prefix) =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const writeFile = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};

describe('Schema diff', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = mkdtemp('davepi-diff-');
  });
  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  });

  test('field-level adds, removes, type changes, enum changes are reported', () => {
    writeFile(
      path.join(tmpRoot, 'v1', 'account.js'),
      `module.exports = { path: 'account', collection: 'accounts', fields: [
        { name: 'name', type: String, required: true },
        { name: 'status', type: String, enum: ['active', 'inactive'] },
        { name: 'priority', type: Number },
      ]};`
    );
    writeFile(
      path.join(tmpRoot, 'v2', 'account.js'),
      `module.exports = { path: 'account', collection: 'accounts', fields: [
        { name: 'displayName', type: String, required: true },
        { name: 'status', type: String, enum: ['active', 'inactive', 'archived'] },
        { name: 'priority', type: String },
      ]};`
    );

    const d = diffVersions(path.join(tmpRoot, 'v1'), path.join(tmpRoot, 'v2'));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toHaveLength(1);
    const change = d.changed[0];
    expect(change.path).toBe('account');
    expect(change.fields.added).toEqual(['displayName']);
    expect(change.fields.removed).toEqual(['name']);
    const priority = change.fields.changed.find((c) => c.name === 'priority');
    expect(priority.reasons[0]).toEqual({ kind: 'type', from: 'Number', to: 'String' });
    const stat = change.fields.changed.find((c) => c.name === 'status');
    expect(stat.reasons[0]).toEqual({
      kind: 'enum',
      from: ['active', 'inactive'],
      to: ['active', 'inactive', 'archived'],
    });
  });

  test('schema added in `to` shows up under `added`; dropped under `removed`', () => {
    writeFile(
      path.join(tmpRoot, 'v1', 'foo.js'),
      `module.exports = { path: 'foo', collection: 'foos', fields: [{ name: 'x', type: String }] };`
    );
    writeFile(
      path.join(tmpRoot, 'v2', 'bar.js'),
      `module.exports = { path: 'bar', collection: 'bars', fields: [{ name: 'y', type: String }] };`
    );

    const d = diffVersions(path.join(tmpRoot, 'v1'), path.join(tmpRoot, 'v2'));
    expect(d.added.map((s) => s.path)).toEqual(['bar']);
    expect(d.removed.map((s) => s.path)).toEqual(['foo']);
    expect(d.changed).toEqual([]);
  });

  test('formatDiff prints a human-readable summary', () => {
    writeFile(
      path.join(tmpRoot, 'v1', 'account.js'),
      `module.exports = { path: 'account', collection: 'accounts', fields: [{ name: 'old', type: String }] };`
    );
    writeFile(
      path.join(tmpRoot, 'v2', 'account.js'),
      `module.exports = { path: 'account', collection: 'accounts', fields: [{ name: 'new', type: String }] };`
    );
    const d = diffVersions(path.join(tmpRoot, 'v1'), path.join(tmpRoot, 'v2'));
    const out = formatDiff(d);
    expect(out).toContain('account');
    expect(out).toContain('+ new');
    expect(out).toContain('- old');
  });
});

describe('Migration scaffold', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = mkdtemp('davepi-scaffold-');
  });
  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  });

  test('writeScaffold without --from/--to writes a timestamped empty template', () => {
    const file = writeScaffold({ name: 'add tasks', dir: tmpRoot });
    expect(fs.existsSync(file)).toBe(true);
    expect(path.basename(file)).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-add-tasks\.js$/);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('async up(db)');
    expect(body).toContain('async down(db)');
  });

  test('scaffoldFromDiff infers a single rename as a $set + $unset', () => {
    const auto = scaffoldFromDiff({
      added: [],
      removed: [],
      changed: [
        {
          path: 'account',
          collection: 'accounts',
          fields: { added: ['name'], removed: ['accountName'], changed: [] },
        },
      ],
    });
    expect(auto).toContain('rename accountName → name');
    // Up moves accountName → name
    expect(auto).toMatch(/\$set:\s*\{\s*"name":\s*'\$accountName'/);
    expect(auto).toContain('$unset: "accountName"');
    // Down moves name → accountName
    expect(auto).toMatch(/\$set:\s*\{\s*"accountName":\s*'\$name'/);
  });

  test('scaffoldFromDiff with no changes returns null (caller falls back to empty template)', () => {
    expect(scaffoldFromDiff({ added: [], removed: [], changed: [] })).toBeNull();
  });

  test('writeScaffold with --from and --to pre-fills from the diff', () => {
    const versionsRoot = path.join(tmpRoot, 'versions');
    writeFile(
      path.join(versionsRoot, 'v1', 'account.js'),
      `module.exports = { path: 'account', collection: 'accounts', fields: [{ name: 'old', type: String }] };`
    );
    writeFile(
      path.join(versionsRoot, 'v2', 'account.js'),
      `module.exports = { path: 'account', collection: 'accounts', fields: [{ name: 'new', type: String }] };`
    );
    const file = writeScaffold({
      name: 'rename old',
      dir: tmpRoot,
      fromVersion: 'v1',
      toVersion: 'v2',
      schemasRoot: versionsRoot,
    });
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('rename old → new');
  });
});

describe('Migration runner', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtemp('davepi-run-');
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  test('migrate applies pending; status flips to applied; rerun is a no-op', async () => {
    writeFile(
      path.join(dir, '2026-01-01-000000-create.js'),
      `module.exports = {
        async up(db) {
          await db.collection('mig_test').insertOne({ marker: 'one' });
        },
        async down(db) {
          await db.collection('mig_test').deleteOne({ marker: 'one' });
        },
      };`
    );

    const before = await status({ db, dir });
    expect(before).toEqual([
      { name: '2026-01-01-000000-create', file: '2026-01-01-000000-create.js', applied: false },
    ]);

    const ran = await migrateUp({ db, dir });
    expect(ran.map((r) => r.name)).toEqual(['2026-01-01-000000-create']);
    const docs = await db.collection('mig_test').find().toArray();
    expect(docs.map((d) => d.marker)).toEqual(['one']);

    const after = await status({ db, dir });
    expect(after[0].applied).toBe(true);

    // Re-run is a no-op.
    const second = await migrateUp({ db, dir });
    expect(second).toEqual([]);
  });

  test('migrate:down reverts the most recently applied', async () => {
    writeFile(
      path.join(dir, '2026-01-01-000000-add.js'),
      `module.exports = {
        async up(db) { await db.collection('mig_test').insertOne({ k: 'a' }); },
        async down(db) { await db.collection('mig_test').deleteOne({ k: 'a' }); },
      };`
    );
    writeFile(
      path.join(dir, '2026-01-02-000000-add.js'),
      `module.exports = {
        async up(db) { await db.collection('mig_test').insertOne({ k: 'b' }); },
        async down(db) { await db.collection('mig_test').deleteOne({ k: 'b' }); },
      };`
    );

    await migrateUp({ db, dir });
    expect(
      (await db.collection('mig_test').find().toArray()).map((d) => d.k).sort()
    ).toEqual(['a', 'b']);

    const r = await migrateDown({ db, dir });
    expect(r.name).toBe('2026-01-02-000000-add');
    expect(
      (await db.collection('mig_test').find().toArray()).map((d) => d.k)
    ).toEqual(['a']);

    const status1 = await status({ db, dir });
    expect(status1.find((s) => s.name === '2026-01-02-000000-add').applied).toBe(false);
  });

  test('--dry mode reports what would happen but does not mutate state', async () => {
    writeFile(
      path.join(dir, '2026-01-01-000000-noop.js'),
      `module.exports = {
        async up(db) { await db.collection('mig_test').insertOne({ touched: true }); },
        async down(db) { await db.collection('mig_test').deleteMany({}); },
      };`
    );
    const ran = await migrateUp({ db, dir, dry: true });
    expect(ran).toHaveLength(1);
    expect(ran[0].dryRun).toBe(true);
    // No marker doc and no _migrations row.
    expect(await db.collection('mig_test').countDocuments()).toBe(0);
    expect(
      await db.collection('_migrations').countDocuments({ name: { $ne: '__lock' } })
    ).toBe(0);
  });

  test('migrate:status reports both pending and applied entries', async () => {
    writeFile(
      path.join(dir, '2026-01-01-000000-a.js'),
      `module.exports = { async up(db) {}, async down(db) {} };`
    );
    writeFile(
      path.join(dir, '2026-01-02-000000-b.js'),
      `module.exports = { async up(db) {}, async down(db) {} };`
    );
    await migrateUp({ db, dir });
    // Drop the second from _migrations so it appears pending again.
    await db
      .collection('_migrations')
      .deleteOne({ name: '2026-01-02-000000-b' });
    const items = await status({ db, dir });
    const map = Object.fromEntries(items.map((i) => [i.name, i.applied]));
    expect(map).toEqual({
      '2026-01-01-000000-a': true,
      '2026-01-02-000000-b': false,
    });
  });
});

describe('Migration lock contention', () => {
  test('concurrent acquireLock attempts: only one wins', async () => {
    const [a, b] = await Promise.all([acquireLock(db), acquireLock(db)]);
    const wins = [a, b].filter(Boolean);
    expect(wins).toHaveLength(1);
    await releaseLock(db, wins[0]);
  });

  test('stale lock is reaped on the next acquire attempt', async () => {
    // Plant a stale lock manually.
    await db.collection('_migrations').createIndex({ name: 1 }, { unique: true });
    await db.collection('_migrations').insertOne({
      name: '__lock',
      lockedAt: new Date(Date.now() - 60 * 60 * 1000),
      owner: 'ghost',
    });
    const owner = await acquireLock(db, { staleMs: 60_000 });
    expect(owner).toBeTruthy();
    expect(owner).not.toBe('ghost');
    await releaseLock(db, owner);
  });

  test('two concurrent migrate runs do not double-apply', async () => {
    const dir = mkdtemp('davepi-conflict-');
    try {
      writeFile(
        path.join(dir, '2026-01-01-000000-once.js'),
        `module.exports = {
          async up(db) {
            await db.collection('mig_test').insertOne({ ran: true });
          },
          async down(db) {},
        };`
      );

      const results = await Promise.allSettled([
        migrateUp({ db, dir }),
        migrateUp({ db, dir }),
      ]);
      // Exactly one succeeds with a non-empty ran list; the other
      // either rejects with the lock error or returns [] if it ran
      // sequentially after the first's release.
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      // The migration only applies once.
      expect(await db.collection('mig_test').countDocuments({ ran: true })).toBe(1);
      const appliedRows = await db
        .collection('_migrations')
        .countDocuments({ name: '2026-01-01-000000-once' });
      expect(appliedRows).toBe(1);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
