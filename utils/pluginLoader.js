/**
 * Plugin loader.
 *
 * Plugins are global extensions to davepi — they receive the live
 * Express app, the schema registry, and the in-process event bus, and
 * are expected to use them. Schema-level lifecycle hooks
 * (`hooks.beforeCreate`, etc., defined in `utils/hooks.js`) are the
 * right tool for per-resource invariants; plugins are the right tool
 * for cross-cutting concerns — audit fan-out, custom routes, scheduled
 * background work, integrations with third-party systems.
 *
 * Registration:
 *
 *   // In the consumer project's package.json
 *   "davepi": {
 *     "plugins": [
 *       "./plugins/audit-export.js",   // path relative to cwd
 *       "davepi-plugin-slack"          // npm package
 *     ]
 *   }
 *
 *   // ./plugins/audit-export.js
 *   module.exports = {
 *     name: 'audit-export',
 *     async setup({ app, schemaLoader, bus, log, appName }) {
 *       app.get('/api/v1/_audit-export', auth(true), handler);
 *       bus.on('record', (event) => { ... });
 *     },
 *   };
 *
 * Contract:
 *   - `name` is required and used as the logger key.
 *   - `setup` is called exactly once per process. It can be async; the
 *     loader awaits each plugin in declaration order so a plugin that
 *     adds shared state for later plugins is well-defined.
 *   - The Express `app` is the same one schemas mounted onto, so
 *     `app.use(...)` works for cross-cutting middleware and routes.
 *     `errorHandler` is re-asserted at the tail of the stack after the
 *     plugins finish loading.
 *   - The `bus` is the same `EventEmitter` from `utils/events.js` that
 *     fires `record` events for every CRUD mutation, so plugins
 *     compose with the existing webhook dispatcher.
 *
 * Errors during plugin setup currently propagate — a broken plugin
 * fails the boot. This is intentional for the first cut: silently
 * dropping a plugin would hide misconfiguration from operators.
 */

const path = require('path');
const fs = require('fs');
const baseLogger = require('./logger');

/**
 * Read the `davepi.plugins` list from the consumer project's
 * package.json (resolved against `cwd`). Returns an empty array when
 * the file or the key is absent.
 */
function readPluginListFromPackageJson(cwd) {
  const pkgPath = path.resolve(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    baseLogger.warn({ err, pkgPath }, 'plugin loader: package.json is not valid JSON');
    return [];
  }
  const list = pkg && pkg.davepi && pkg.davepi.plugins;
  if (!Array.isArray(list)) return [];
  return list;
}

/**
 * Resolve a plugin specifier to a loaded module. Specifiers can be:
 *   - "./relative/path"     → resolved against `cwd`
 *   - "/absolute/path"      → loaded as-is
 *   - "package-name"        → loaded via Node's require resolution
 *     starting from `cwd` (so consumer-installed packages win over
 *     anything next to the framework).
 */
function resolvePlugin(spec, cwd) {
  if (typeof spec !== 'string' || !spec.length) {
    throw new TypeError(`plugin spec must be a non-empty string, got ${typeof spec}`);
  }
  if (spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec)) {
    return require(path.resolve(cwd, spec));
  }
  const resolved = require.resolve(spec, { paths: [cwd] });
  return require(resolved);
}

/**
 * Load every plugin in `plugins` (a list of specifiers OR plugin
 * objects — the latter is the in-process form used by tests). Plugins
 * run in declaration order. Returns the array of loaded plugin
 * descriptors so callers can inspect what wound up registered.
 *
 * `cwd` defaults to process.cwd() so package.json-listed plugins
 * resolve against the consumer's project, not davepi's own directory.
 */
async function loadPlugins({
  plugins,
  app,
  schemaLoader,
  bus,
  appName,
  cwd = process.cwd(),
  log = baseLogger,
}) {
  const specs = Array.isArray(plugins)
    ? plugins
    : readPluginListFromPackageJson(cwd);
  if (!specs.length) return [];

  const loaded = [];
  for (const spec of specs) {
    const mod = typeof spec === 'string' ? resolvePlugin(spec, cwd) : spec;
    const plugin = mod && mod.default ? mod.default : mod;
    if (!plugin || typeof plugin.setup !== 'function') {
      throw new TypeError(
        `davepi plugin "${typeof spec === 'string' ? spec : '<inline>'}" ` +
          'must export an object with a `setup` function'
      );
    }
    const name = plugin.name || (typeof spec === 'string' ? spec : '<inline>');
    const pluginLog = log.child ? log.child({ plugin: name }) : log;
    await plugin.setup({
      app,
      schemaLoader,
      bus,
      appName,
      log: pluginLog,
    });
    loaded.push({ name, plugin });
    log.info({ plugin: name }, 'plugin loaded');
  }
  return loaded;
}

module.exports = {
  loadPlugins,
  readPluginListFromPackageJson,
  resolvePlugin,
};
