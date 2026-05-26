'use strict';

/**
 * davepi-plugin-object-storage
 *
 * Presigned-URL file uploads for dAvePi. Mounted by listing the package
 * under the consumer project's `package.json -> davepi.plugins`:
 *
 *   {
 *     "davepi": { "plugins": ["davepi-plugin-object-storage"] }
 *   }
 *
 * Where this fits in the framework: the in-tree `type: 'File'` field
 * is the per-record-field, proxy-the-bytes pipeline that's fine for
 * avatars and document attachments. This plugin is the "client uploads
 * straight to the bucket" pipeline: the API never sees the bytes, big
 * files don't choke serverless request limits, and files become a
 * first-class queryable resource (one row per file, not embedded on a
 * parent record). Both can coexist in the same app.
 *
 * Behaviour at setup:
 *
 *   1. If `S3_BUCKET` is unset (or `S3_BACKEND=gcs` with no GCS SDK
 *      installed), the plugin stays dormant. Routes are not mounted,
 *      the schema is not registered, the reaper does not start. Calls
 *      to `createUploadUrl` / `deleteFile` throw a clear "configure
 *      S3_BUCKET" message.
 *   2. The configured adapter is constructed (aws / r2 / minio / gcs).
 *   3. The `file` schema is registered via `schemaLoader.loadSchema`
 *      so REST / GraphQL / MCP / Swagger / the admin SPA see it.
 *   4. Three routes are mounted under `S3_ROUTE_PREFIX` (default
 *      `/api/files`): upload-url, :id/complete, :id/download-url.
 *   5. The reaper starts (unless `S3_REAP_ENABLED=false`) and sweeps
 *      orphaned `pending` records every `S3_REAP_INTERVAL_MS`.
 *
 * The plugin also exports a small programmatic API for callers who want
 * to drive uploads from a schema lifecycle hook or a custom route:
 * `createUploadUrl`, `createDownloadUrl`, `deleteFile`. Each requires a
 * `user` parameter (the JWT payload) so tenant scoping is explicit.
 */

const { readConfig } = require('./lib/config');
const { createAdapter } = require('./lib/adapters');
const { buildFileSchema } = require('./lib/schema');
const { buildRouter } = require('./lib/routes');
const { createReaper } = require('./lib/reaper');
const { buildKey } = require('./lib/keys');

function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const config = { ...readConfig(env), ...(opts.configOverrides || {}) };
  const sdkOverrides = opts.sdkOverrides || {};
  const adapterOverride = opts.adapter || null;
  const injectedErrors = opts.errors || null;
  const injectedAuth = opts.auth || null;
  const injectedAsyncHandler = opts.asyncHandler || null;
  const injectedMongoose = opts.mongoose || null;
  const injectedExpress = opts.express || null;

  const state = {
    enabled: false,
    adapter: null,
    Model: null,
    reaper: null,
    log: null,
  };

  function ensureEnabled(call) {
    if (!state.enabled) {
      throw new Error(
        `davepi-plugin-object-storage: ${call} called but plugin is dormant ` +
        '(S3_BUCKET not set, or setup has not run yet)'
      );
    }
  }

  async function createUploadUrl({ user, contentType, originalName, size, metadata }) {
    ensureEnabled('createUploadUrl');
    if (!user || !user.user_id) {
      throw new Error('davepi-plugin-object-storage: createUploadUrl requires { user: { user_id } }');
    }
    const userId = String(user.user_id);
    const key = buildKey({ userId, originalName });
    const doc = await state.Model.create({
      userId,
      accountId:   user.account_id ? String(user.account_id) : undefined,
      key,
      bucket:      state.adapter.bucket,
      contentType,
      size:        size != null ? size : undefined,
      status:      'pending',
      originalName,
      metadata:    metadata && typeof metadata === 'object' ? metadata : undefined,
    });
    const url = await state.adapter.getSignedPutUrl({
      key,
      contentType,
      expires: config.putUrlTtlSeconds,
    });
    return { fileId: String(doc._id), key, url, expiresIn: config.putUrlTtlSeconds };
  }

  async function createDownloadUrl({ user, fileId }) {
    ensureEnabled('createDownloadUrl');
    if (!user || !user.user_id) {
      throw new Error('davepi-plugin-object-storage: createDownloadUrl requires { user: { user_id } }');
    }
    const doc = await state.Model.findById(fileId);
    if (!doc || String(doc.userId) !== String(user.user_id)) {
      // Same posture as the REST route: don't leak existence of a
      // foreign-tenant file via a distinct 404-vs-403 response.
      return null;
    }
    if (doc.status !== 'uploaded') return null;
    const url = await state.adapter.getSignedGetUrl({
      key:     doc.key,
      expires: config.getUrlTtlSeconds,
    });
    return { fileId: String(doc._id), url, expiresIn: config.getUrlTtlSeconds };
  }

  async function deleteFile({ user, fileId }) {
    ensureEnabled('deleteFile');
    if (!user || !user.user_id) {
      throw new Error('davepi-plugin-object-storage: deleteFile requires { user: { user_id } }');
    }
    const doc = await state.Model.findById(fileId);
    if (!doc || String(doc.userId) !== String(user.user_id)) return false;
    try {
      await state.adapter.deleteObject({ key: doc.key });
    } catch (err) {
      if (state.log && typeof state.log.warn === 'function') {
        state.log.warn(
          { err, plugin: 'object-storage', key: doc.key },
          'davepi-plugin-object-storage: deleteFile failed to remove storage object'
        );
      }
      // Don't bail — caller asked to delete the record, so we remove
      // it from the DB even if storage hiccups. The orphaned blob will
      // be picked up by a future audit/cleanup; the user-facing API
      // doesn't need to know.
    }
    await state.Model.deleteOne({ _id: doc._id });
    return true;
  }

  async function setup({ app, schemaLoader, bus, log, appName }) {
    state.log = log;

    if (!config.bucket) {
      log.warn(
        { plugin: 'object-storage' },
        'S3_BUCKET not set; davepi-plugin-object-storage is dormant'
      );
      return;
    }
    if (!schemaLoader || typeof schemaLoader.loadSchema !== 'function') {
      log.error(
        { plugin: 'object-storage' },
        'davepi-plugin-object-storage setup({ schemaLoader }) is required; staying dormant'
      );
      return;
    }
    if (!app || typeof app.use !== 'function') {
      log.error(
        { plugin: 'object-storage' },
        'davepi-plugin-object-storage setup({ app }) is required; staying dormant'
      );
      return;
    }

    // Lazy-resolve framework deps so the package's own unit tests
    // (which don't install `davepi`) can run standalone.
    let mongoose = injectedMongoose;
    if (!mongoose) {
      try {
        mongoose = require('mongoose');
      } catch (err) {
        log.error(
          { err, plugin: 'object-storage' },
          "could not require 'mongoose' to register file schema; staying dormant"
        );
        return;
      }
    }
    let errors = injectedErrors;
    if (!errors) {
      try {
        errors = require('davepi/utils/errors');
      } catch (err) {
        log.error(
          { err, plugin: 'object-storage' },
          "could not require 'davepi/utils/errors'; staying dormant"
        );
        return;
      }
    }
    let auth = injectedAuth;
    if (!auth) {
      try {
        auth = require('davepi/middleware/auth');
      } catch (err) {
        log.error(
          { err, plugin: 'object-storage' },
          "could not require 'davepi/middleware/auth'; staying dormant"
        );
        return;
      }
    }
    let asyncHandler = injectedAsyncHandler;
    if (!asyncHandler) {
      try {
        asyncHandler = require('davepi/utils/asyncHandler');
      } catch (err) {
        log.error(
          { err, plugin: 'object-storage' },
          "could not require 'davepi/utils/asyncHandler'; staying dormant"
        );
        return;
      }
    }

    // Adapter. A throw here (e.g. missing @google-cloud/storage when
    // S3_BACKEND=gcs) is logged and the plugin stays dormant rather
    // than crashing boot — same posture as the postmark inbound
    // half-config branch.
    try {
      state.adapter = adapterOverride || createAdapter(config, { sdkOverrides });
    } catch (err) {
      log.error(
        { err, plugin: 'object-storage', backend: config.backend },
        'davepi-plugin-object-storage: adapter construction failed; staying dormant'
      );
      return;
    }

    // Register the file schema. The afterDelete hook needs the live
    // adapter, so we pass a thunk rather than the adapter itself —
    // makes the schema reusable if the adapter is swapped in tests.
    const schema = buildFileSchema({
      mongoose,
      errors,
      version:       config.fileVersion,
      path:          config.filePath,
      cascadeDelete: config.cascadeDelete,
      getAdapter:    () => state.adapter,
      log,
    });
    try {
      await schemaLoader.loadSchema(schema);
    } catch (err) {
      log.error(
        { err, plugin: 'object-storage' },
        'davepi-plugin-object-storage: failed to register file schema; staying dormant'
      );
      return;
    }
    const entry = schemaLoader.getEntry(`${config.fileVersion}/${config.filePath}`);
    if (!entry || !entry.model) {
      log.error(
        { plugin: 'object-storage' },
        'davepi-plugin-object-storage: file schema registered but model is missing; staying dormant'
      );
      return;
    }
    state.Model = entry.model;

    // Mount routes on the live Express app. The framework's plugin
    // loader re-asserts the terminal errorHandler after every plugin
    // returns, so the per-route asyncHandler-wrapped throws land on
    // the centralised response shape.
    let expressMod = injectedExpress;
    if (!expressMod) {
      try {
        expressMod = require('express');
      } catch (err) {
        log.error(
          { err, plugin: 'object-storage' },
          "could not require 'express' to build router; staying dormant"
        );
        return;
      }
    }
    const router = expressMod.Router();
    buildRouter({
      router,
      auth,
      asyncHandler,
      errors,
      getModel: () => state.Model,
      adapter:  state.adapter,
      config,
    });
    app.use(config.routePrefix, router);
    // `app.use` appends to the middleware stack — so the just-mounted
    // router sits AFTER the framework's terminal `errorHandler`,
    // meaning a thrown `ValidationError` from our routes would bypass
    // the centralised response shape. The framework re-asserts the
    // errorHandler tail after the whole plugin batch completes (see
    // app.js's `if (app.locals.plugins.length)` block); calling it
    // here as well keeps the invariant correct for tests + hot-paths
    // that load the plugin after boot. The operation is idempotent —
    // it splices any existing errorHandler before re-appending.
    if (typeof schemaLoader.moveErrorHandlerToEnd === 'function') {
      schemaLoader.moveErrorHandlerToEnd();
    }

    state.reaper = createReaper({
      getModel: () => state.Model,
      adapter:  state.adapter,
      config,
      log,
    });
    state.reaper.start();

    state.enabled = true;

    log.info(
      {
        plugin:        's3',
        backend:       config.backend,
        bucket:        config.bucket,
        filePath:      `${config.fileVersion}/${config.filePath}`,
        routePrefix:   config.routePrefix,
        cascadeDelete: config.cascadeDelete,
        reapEnabled:   config.reapEnabled,
      },
      'davepi-plugin-object-storage ready'
    );

    // Keep references the contract guarantees we receive even when we
    // don't use them — same convention slack/audit follow so the
    // documented setup signature stays exercised.
    void bus;
    void appName;
  }

  return {
    name: 'object-storage',
    setup,
    createUploadUrl,
    createDownloadUrl,
    deleteFile,
    // Adapter escape hatch for advanced consumers — see ticket #112's
    // "Adapter escape hatch" note.
    get adapter() {
      return state.adapter;
    },
    // Exposed for tests + integration suites. Not part of the public
    // API contract.
    _state: state,
    _config: config,
  };
}

const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
module.exports.buildKey = buildKey;
