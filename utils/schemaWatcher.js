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
}) {
  const enabled =
    process.env.NODE_ENV !== 'production' &&
    process.env.HOT_RELOAD_SCHEMAS === 'true';

  if (!enabled) return { stop: async () => {} };

  // Required only when enabled so the prod image isn't forced to bundle
  // chokidar (it's a dependency, but lazy-requiring keeps boot light).
  const chokidar = require('chokidar');

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

  const handleAddOrChange = async (filePath) => {
    try {
      const schema = requireFresh(filePath);
      schema.version = versionFromFile(filePath);
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
