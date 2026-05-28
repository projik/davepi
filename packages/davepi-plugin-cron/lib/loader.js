'use strict';

/**
 * Read `davepi.cron` from the consumer project's `package.json`
 * (resolved against `cwd`) and resolve each handler module
 * reference. Returns the list of jobs ready for `register()` —
 * one per key under `davepi.cron`.
 *
 * Mirrors `utils/pluginLoader.js#readPluginListFromPackageJson` —
 * missing file, missing key, or bad JSON yields an empty list with
 * a logged warning; no crash. The cron block is OPTIONAL; consumers
 * can register programmatically instead.
 *
 * Handler module spec:
 *   - "./relative/path" or "../"          → resolved against cwd
 *   - "/absolute/path"                    → loaded as-is
 *   - "package-name"                      → resolved via Node, paths: [cwd]
 *
 * The exported module is the handler function OR an object with
 * `{ handler, schedule, timezone, leaseSeconds }` to override the
 * package.json declaration from the module side.
 */

const path = require('path');
const fs = require('fs');

function readPackageJsonCronBlock({ cwd, log }) {
  const pkgPath = path.resolve(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return {};
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    log.warn(
      { err, pkgPath, plugin: 'cron' },
      "davepi-plugin-cron: package.json is not valid JSON; skipping declarative cron block",
    );
    return {};
  }
  const block = pkg && pkg.davepi && pkg.davepi.cron;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {};
  return block;
}

function resolveHandlerSpec(spec, cwd) {
  if (typeof spec !== 'string' || !spec.length) {
    throw new TypeError(`cron handler spec must be a non-empty string, got ${typeof spec}`);
  }
  if (spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec)) {
    return require(path.resolve(cwd, spec));
  }
  const resolved = require.resolve(spec, { paths: [cwd] });
  return require(resolved);
}

/**
 * Walk `davepi.cron` and produce a list of normalised job
 * definitions. Each declaration MUST carry `schedule` and `handler`;
 * anything missing surfaces as a thrown error so a typo doesn't
 * silently disable a job (a job that quietly never runs is harder
 * to diagnose than one that fails loudly at boot).
 *
 * `requireFn` is injectable so tests don't have to write a real
 * handler module to disk.
 */
function loadDeclarativeJobs({ cwd = process.cwd(), log, requireFn }) {
  const resolve = requireFn || ((spec) => resolveHandlerSpec(spec, cwd));
  const block = readPackageJsonCronBlock({ cwd, log });
  const jobs = [];
  for (const [name, decl] of Object.entries(block)) {
    if (!decl || typeof decl !== 'object') {
      throw new Error(`davepi-plugin-cron: davepi.cron['${name}'] must be an object`);
    }
    if (typeof decl.schedule !== 'string' || !decl.schedule.length) {
      throw new Error(`davepi-plugin-cron: davepi.cron['${name}'].schedule must be a non-empty string`);
    }
    if (typeof decl.handler !== 'string' || !decl.handler.length) {
      throw new Error(`davepi-plugin-cron: davepi.cron['${name}'].handler must be a non-empty string (module path or package name)`);
    }
    let mod;
    try {
      mod = resolve(decl.handler);
    } catch (err) {
      throw new Error(
        `davepi-plugin-cron: failed to load handler for '${name}' (${decl.handler}): ${err.message}`,
      );
    }
    // The handler module is either a function, an object with
    // `handler`, or an object whose `default` is a function (ESM
    // interop). Anything else is a misconfiguration we'd rather
    // surface at boot than at first tick.
    let handlerFn;
    let overrides = {};
    if (typeof mod === 'function') {
      handlerFn = mod;
    } else if (mod && typeof mod.handler === 'function') {
      handlerFn = mod.handler;
      overrides = mod;
    } else if (mod && typeof mod.default === 'function') {
      handlerFn = mod.default;
    } else {
      throw new Error(
        `davepi-plugin-cron: handler module for '${name}' must export a function or { handler }`,
      );
    }
    jobs.push({
      name,
      handler:      handlerFn,
      schedule:     overrides.schedule     || decl.schedule,
      timezone:     overrides.timezone     || decl.timezone     || null,
      leaseSeconds: overrides.leaseSeconds || decl.leaseSeconds || null,
    });
  }
  return jobs;
}

module.exports = { loadDeclarativeJobs, readPackageJsonCronBlock };
