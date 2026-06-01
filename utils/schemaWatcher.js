const path = require('path');
const logger = require('./logger');

/**
 * Watch the schema directory and call loadSchema / unloadSchema in
 * response to filesystem events. Gated behind NODE_ENV !== 'production'
 * AND HOT_RELOAD_SCHEMAS=true so this never runs by accident in prod —
 * `require()`-cache busting at runtime is dangerous if schemas have
 * side effects.
 *
 * Uses a small per-file debounce because editors save in two phases
 * (truncate + write) and chokidar emits two events.
 */
function startSchemaWatcher({
  loader,
  schemasDir = path.resolve('./schema/versions'),
  // Injectable for tests: chokidar v4 is ESM and can't be `require()`d
  // under Jest's CJS module runtime, so the suite passes a lightweight
  // fake here. Production leaves it undefined and lazy-requires the real
  // module below.
  _chokidar,
}) {
  const enabled =
    process.env.NODE_ENV !== 'production' &&
    process.env.HOT_RELOAD_SCHEMAS === 'true';

  if (!enabled) return { stop: async () => {} };

  // Required only when enabled so the prod image isn't forced to bundle
  // chokidar (it's a dependency, but lazy-requiring keeps boot light).
  const chokidar = _chokidar || require('chokidar');

  const fileToKey = new Map(); // absolute path -> registry key (`${version}/${path}`)
  const debounceTimers = new Map();
  const DEBOUNCE_MS = 100;

  const versionFromFile = (filePath) => {
    // schema/versions/v1/account.js -> v1
    const rel = path.relative(schemasDir, filePath);
    return rel.split(path.sep)[0];
  };

  const requireFresh = (filePath) => {
    delete require.cache[require.resolve(filePath)];
    return require(filePath);
  };

  // Seed the file->key map from schemas that were already loaded at boot.
  // `app.js` stamps each boot-loaded schema with `__sourceFile`, and the
  // loader stores it in the registry. Without this seed, `ignoreInitial:
  // true` means the watcher never sees an 'add' for those files, so
  // `fileToKey` has no entry and a later 'unlink' (the developer deleting
  // a starter schema like `note.js`, exactly as the tutorials suggest)
  // would early-return and leave the routes / model / GraphQL fields
  // registered forever.
  const seedFromRegistry = () => {
    if (typeof loader.listSchemas !== 'function' || typeof loader.getEntry !== 'function') {
      return;
    }
    for (const key of loader.listSchemas()) {
      const entry = loader.getEntry(key);
      const sourceFile = entry && entry.schema && entry.schema.__sourceFile;
      if (sourceFile && !fileToKey.has(sourceFile)) {
        fileToKey.set(sourceFile, key);
      }
    }
  };

  const handleAddOrChange = async (filePath) => {
    try {
      const schema = requireFresh(filePath);
      // Editors create a new file empty and only then do you type into
      // it, so the first event for `workout.js` fires while the module
      // still exports `{}` (and a half-finished save may export a
      // `path` but no `fields` yet). Neither is a loadable schema —
      // handing it to the loader would crash on `s.fields.forEach` and
      // surface as a scary "schema reload failed" error on every new
      // file. Skip quietly and wait for the next save, which fires its
      // own 'change' event once the file exports `{ path, fields }`.
      if (
        !schema ||
        typeof schema !== 'object' ||
        typeof schema.path !== 'string' ||
        !Array.isArray(schema.fields)
      ) {
        logger.debug(
          { filePath },
          'schema file not loadable yet (missing path/fields); skipping until next save'
        );
        return;
      }
      schema.__sourceFile = filePath;
      schema.version = versionFromFile(filePath);
      const newKey = `${schema.version}/${schema.path}`;
      const previousKey = fileToKey.get(filePath);

      // If the file used to register under a different key (developer
      // renamed `schema.path` or moved the file between version dirs),
      // tear down the stale registration first. Without this, the old
      // routes / Mongoose model / GraphQL fields would linger forever.
      if (previousKey && previousKey !== newKey) {
        try {
          await loader.unloadSchema(previousKey);
        } catch (err) {
          logger.error(
            { err, filePath, previousKey },
            'schema unload of previous identity failed; reloading anyway'
          );
        }
      }

      const key = await loader.loadSchema(schema);
      fileToKey.set(filePath, key);
    } catch (err) {
      logger.error({ err, filePath }, 'schema reload failed');
    }
  };

  const handleUnlink = async (filePath) => {
    const key = fileToKey.get(filePath);
    if (!key) return;
    fileToKey.delete(filePath);
    try {
      await loader.unloadSchema(key);
    } catch (err) {
      logger.error({ err, filePath }, 'schema unload failed');
    }
  };

  const debounce = (filePath, fn) => {
    const existing = debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      filePath,
      setTimeout(() => {
        debounceTimers.delete(filePath);
        fn(filePath);
      }, DEBOUNCE_MS)
    );
  };

  seedFromRegistry();

  const watcher = chokidar.watch(schemasDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher
    .on('add', (filePath) => debounce(filePath, handleAddOrChange))
    .on('change', (filePath) => debounce(filePath, handleAddOrChange))
    .on('unlink', (filePath) => debounce(filePath, handleUnlink));

  logger.info({ schemasDir }, 'schema watcher started (HOT_RELOAD_SCHEMAS=true)');

  return {
    stop: async () => {
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      await watcher.close();
    },
  };
}

module.exports = { startSchemaWatcher };
