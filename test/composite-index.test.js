const mongoose = require('mongoose');
const { setupTestApp } = require('./helpers');

const ctx = setupTestApp();

/**
 * compositeIndex entry forms (utils/schemaLoader.js).
 *
 * Legacy shorthand — a plain key object — has always meant a UNIQUE
 * compound index (per-tenant uniqueness is its primary use), and must
 * stay that way for back-compat. The long form
 * `{ fields: {...}, unique: false }` opts a composite index out of
 * uniqueness so it can serve as a plain query index; before it existed
 * every composite index silently capped the collection at one row per
 * key combination.
 */

const loadSchema = (s) => ctx.app.locals.schemaLoader.loadSchema(s);

const findIndex = (model, keys) =>
  model.schema
    .indexes()
    .find(
      ([k]) =>
        Object.keys(keys).length === Object.keys(k).length &&
        Object.entries(keys).every(([f, dir]) => k[f] === dir)
    );

describe('compositeIndex entry forms', () => {
  test('legacy plain key object stays unique', async () => {
    await loadSchema({
      path: 'cilegacy',
      collection: 'cilegacy',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'slug', type: String, required: true },
      ],
      compositeIndex: [{ userId: 1, slug: 1 }],
    });

    const model = mongoose.models.cilegacy;
    const [, options] = findIndex(model, { userId: 1, slug: 1 });
    expect(options.unique).toBe(true);

    // Behavior check: the second row with the same key pair is rejected
    // at the database, not just declared in the schema.
    await model.init();
    await model.create({ userId: 'u1', slug: 'dup' });
    await expect(model.create({ userId: 'u1', slug: 'dup' })).rejects.toThrow(
      /E11000/
    );
  });

  test('long form { fields, unique: false } builds a plain query index', async () => {
    await loadSchema({
      path: 'ciplain',
      collection: 'ciplain',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'parentId', type: String, required: true },
      ],
      compositeIndex: [{ fields: { userId: 1, parentId: 1 }, unique: false }],
    });

    const model = mongoose.models.ciplain;
    const [, options] = findIndex(model, { userId: 1, parentId: 1 });
    expect(options.unique).toBe(false);

    // The regression this form exists for: many rows per key pair.
    await model.init();
    await model.create({ userId: 'u1', parentId: 'p1' });
    await model.create({ userId: 'u1', parentId: 'p1' });
    expect(await model.countDocuments({ userId: 'u1', parentId: 'p1' })).toBe(2);
  });

  test('long form without a unique flag defaults to unique', async () => {
    await loadSchema({
      path: 'cidefault',
      collection: 'cidefault',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'slug', type: String, required: true },
      ],
      compositeIndex: [{ fields: { userId: 1, slug: 1 } }],
    });

    const [, options] = findIndex(mongoose.models.cidefault, {
      userId: 1,
      slug: 1,
    });
    expect(options.unique).toBe(true);
  });

  test('long form with unique: true stays unique', async () => {
    await loadSchema({
      path: 'ciexplicit',
      collection: 'ciexplicit',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'slug', type: String, required: true },
      ],
      compositeIndex: [{ fields: { userId: 1, slug: 1 }, unique: true }],
    });

    const [, options] = findIndex(mongoose.models.ciexplicit, {
      userId: 1,
      slug: 1,
    });
    expect(options.unique).toBe(true);
  });

  test('shorthand spec with a field literally named "fields" stays shorthand', async () => {
    // The long-form detector keys on a `fields` property — a shorthand
    // index over a field that happens to be named `fields` must not be
    // misparsed into `index(1, ...)`.
    await loadSchema({
      path: 'cifieldskey',
      collection: 'cifieldskey',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'fields', type: String, required: true },
      ],
      compositeIndex: [{ userId: 1, fields: 1 }],
    });

    const [, options] = findIndex(mongoose.models.cifieldskey, {
      userId: 1,
      fields: 1,
    });
    expect(options.unique).toBe(true);
  });

  test('forms mix within one schema', async () => {
    await loadSchema({
      path: 'cimixed',
      collection: 'cimixed',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'slug', type: String, required: true },
        { name: 'parentId', type: String },
      ],
      compositeIndex: [
        { userId: 1, slug: 1 },
        { fields: { userId: 1, parentId: 1 }, unique: false },
      ],
    });

    const model = mongoose.models.cimixed;
    expect(findIndex(model, { userId: 1, slug: 1 })[1].unique).toBe(true);
    expect(findIndex(model, { userId: 1, parentId: 1 })[1].unique).toBe(false);
  });
});
