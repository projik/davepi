const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const timestamps = require('mongoose-timestamp');
const m2s = require('mongoose-to-swagger');
const mongoGql = require('graphql-compose-mongoose');
const mongoSc = require('graphql-compose');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@as-integrations/express4');
const { ApolloError } = require('./graphqlErrors');
const MongoQS = require('mongo-querystring');

const auth = require('../middleware/auth');
const requireScope = require('../middleware/requireScope');
const asyncHandler = require('./asyncHandler');
const logger = require('./logger');
const { NotFoundError, ValidationError, InvalidTransitionError } = require('./errors');
const { emitRecordEvent, buildReqMeta } = require('./events');
const { recordAudit } = require('./audit');
const AuditLog = require('../model/auditLog');
const {
  validateAndCastParams,
  buildPipeline,
  AggregationParamError,
  AggregationSafetyError,
  ALLOWED_PARAM_TYPES,
} = require('./aggregations');
const { createAggregationCache } = require('./aggregationCache');
const aggregationCache = createAggregationCache();
const { buildIdempotency } = require('../middleware/idempotency');
const {
  normalizeRelations,
  parseIncludes,
  applyIncludes,
} = require('./relations');
const {
  isComputedField,
  computedFieldsOf,
  buildComputedContext,
  applyComputed,
} = require('./computedFields');
const {
  isStateMachineField,
  stateMachineFieldsOf,
  validateTransition,
  computeAvailableTransitions,
  attachAvailableTransitions,
  stampInitialStates,
  listTransitionsToValidate,
} = require('./stateMachine');
const { runBeforeHook, runAfterHook } = require('./hooks');

/**
 * Map a schema field's declared `type` onto the GraphQL scalar name
 * graphql-compose understands. Computed-field outputs are scalars by
 * design (composite types would require synthesising new TCs per
 * field, which the contract for v1 doesn't promise). Anything we
 * don't recognise falls back to `String` so the schema still builds.
 */
function computedGraphqlType(type) {
  if (Array.isArray(type)) return `[${computedGraphqlType(type[0])}]`;
  if (type === String || type === 'String') return 'String';
  if (type === Number || type === 'Number') return 'Float';
  if (type === Boolean || type === 'Boolean') return 'Boolean';
  if (type === Date || type === 'Date') return 'Date';
  return 'String';
}

/**
 * Map a computed-field's declared `type` into a Swagger 2.0 schema
 * fragment. Used by buildSwagger to inject computed fields with
 * `readOnly: true`.
 */
function computedSwaggerType(type) {
  if (Array.isArray(type)) {
    return { type: 'array', items: computedSwaggerType(type[0]) };
  }
  if (type === String || type === 'String') return { type: 'string' };
  if (type === Number || type === 'Number') return { type: 'number' };
  if (type === Boolean || type === 'Boolean') return { type: 'boolean' };
  if (type === Date || type === 'Date') return { type: 'string', format: 'date-time' };
  return { type: 'string' };
}

const {
  projectByAcl,
  projectListByAcl,
  filterWritable,
  bypassUserScopeForList,
  bypassUserScopeForDelete,
  stampTenantFields,
  stripTenantFields,
  getRoleScopeFilter,
  applyRoleScopeFilter,
} = require('./acl');
const {
  wrapFilter,
  wrapCreateOne,
  wrapCreateMany,
  wrapFindById,
  wrapFindByIds,
  wrapByIdMutation,
  wrapAggregation,
  wrapComputedField,
  wrapStateTransition,
} = require('./scopeResolver');
const {
  FileMetaSchema,
  isFileField,
  fileFieldsOf,
  mongooseTypeFor,
  matchAccept,
  decorateFileUrls,
  decorateListFileUrls,
} = require('./fileFields');
const { getStorageDriver } = require('./storage');
const multer = require('multer');
const crypto = require('crypto');

const qs = new MongoQS();

/**
 * Schema loader / unloader for the dynamic REST + GraphQL surface.
 *
 * Each schema lives in its own express.Router so the loader can splice
 * the router out of the parent app's middleware stack on unload — Express
 * doesn't expose a public "remove route" API. Mongoose models are
 * deleteModel'd; the underlying MongoDB collection persists with data.
 *
 * GraphQL is rebuilt from scratch on every change: every load/unload
 * constructs a fresh SchemaComposer from the registry, builds a new
 * ApolloServer (v5), `await`s its `start()`, mounts `expressMiddleware`
 * onto a brand-new express.Router, and calls the supplied
 * `setApolloRouter` so the indirection middleware mounted in app.js
 * routes new requests through it.
 */
function createSchemaLoader({ app, apiSpec, setApolloRouter, buildGraphqlContext, isProduction, errorHandler }) {
  // key = `${version}/${path}`
  const registry = new Map();

  // Long-lived consumers (the stdio MCP server, future inspectors)
  // subscribe via `onChange` and get notified whenever the registry
  // changes. The HTTP MCP path doesn't use this — it constructs a
  // fresh server per request and reads the live registry.
  const changeListeners = new Set();
  const notifyChange = () => {
    for (const fn of changeListeners) {
      try { fn(); } catch (err) { logger.warn({ err }, 'schema change listener threw'); }
    }
  };

  /**
   * Resolve a relation target's path back to its `{ schema, model }`
   * pair. Used by the `__include` path in REST handlers and the
   * `addRelation` wiring in the GraphQL layer.
   *
   * Lookup order: same-version exact match, then any-version match.
   * Schemas live under one version in practice; the second pass is a
   * defensive escape hatch for cross-version relations a future
   * caller might declare.
   */
  function getResource(targetPath, sourceVersion) {
    if (sourceVersion) {
      const exact = registry.get(`${sourceVersion}/${targetPath}`);
      if (exact) return exact;
    }
    for (const entry of registry.values()) {
      if (entry.schema && entry.schema.path === targetPath) return entry;
    }
    return null;
  }

  // Tracks the live ApolloServer so each rebuildGraphQL can shut down
  // its predecessor — without this, every reload would leak server
  // resources (plugins, timers, internal state).
  let currentApolloServer = null;

  // Serialize loadSchema / unloadSchema / rebuildGraphQL through a
  // single-flight queue so concurrent filesystem events from the watcher
  // can't interleave registry mutations with rebuildGraphQL. Without
  // this, the apolloRouter / swagger state could end up reflecting an
  // intermediate snapshot of the registry depending on which async
  // rebuild resolved last.
  let opChain = Promise.resolve();
  const enqueue = (fn) => {
    const next = opChain.then(fn, fn);
    opChain = next.catch(() => {}); // keep the chain alive on rejection
    return next;
  };

  /**
   * Keep `errorHandler` at the tail of the parent app's middleware
   * stack. Every loadSchema mounts a per-schema router via
   * `app.use(router)`, which appends it to the stack. If errorHandler
   * was already there, it's now no longer last and Express won't route
   * errors from the new router to it. We splice + re-append on every
   * mutation to maintain the invariant.
   */
  function moveErrorHandlerToEnd() {
    if (!errorHandler) return;
    const stack = app._router && app._router.stack;
    if (!stack) return;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].handle === errorHandler) stack.splice(i, 1);
    }
    app.use(errorHandler);
  }

  function buildSchemaArtifacts(s) {
    const fields = {};
    const unique = [];
    const references = [];
    const fileFields = [];
    s.fields.forEach((f) => {
      // Computed / virtual fields are never persisted: they're
      // derived at response time by utils/computedFields.js, so we
      // skip them entirely from the Mongoose schema. Mongoose's
      // `strict: true` would silently drop them anyway, but
      // skipping is cleaner and lets the post-fetch pass own the
      // attribute.
      if (isComputedField(f)) {
        return;
      }
      // type: 'File' fields become embedded sub-docs at the Mongoose
      // layer. Clients never POST these directly — uploads go through
      // the dedicated multipart route per file field.
      if (isFileField(f)) {
        fields[f.name] = mongooseTypeFor(f);
        fileFields.push(f);
        return;
      }
      fields[f.name] = f;
      if (f.unique) unique.push(f.name);
      if (f.reference) references.push(f.reference);
    });

    // Soft-delete support: every record carries a deletedAt tombstone
    // unless the schema explicitly opts out via `softDelete: false`.
    // Reads filter `deletedAt: null` by default; DELETE flips this
    // field instead of removing the document.
    const softDeleteEnabled = s.softDelete !== false;
    if (softDeleteEnabled) {
      fields.deletedAt = { type: Date, default: null, index: true };
    }

    const mongooseSchema = new mongoose.Schema(fields);
    mongooseSchema.plugin(timestamps);
    mongooseSchema.index({ createdAt: 1 });
    mongooseSchema.index({ updatedAt: 1 });
    if (s.compositeIndex) {
      s.compositeIndex.forEach((i) => mongooseSchema.index(i, { unique: true }));
    }

    // Mongo only allows one text index per collection, so the
    // framework owns it: we collect every `searchable: true` field and
    // emit a single compound text index. Title-like fields (name)
    // are weighted higher than body fields by convention so they bubble
    // up the score ranking; callers can override via `searchWeight`.
    const searchableFields = (s.fields || []).filter((f) => f && f.searchable);
    if (searchableFields.length) {
      const textIndex = {};
      const weights = {};
      for (const f of searchableFields) {
        textIndex[f.name] = 'text';
        weights[f.name] = f.searchWeight || 1;
      }
      mongooseSchema.index(textIndex, {
        name: `${s.path}_text`,
        weights,
      });
    }

    return {
      mongooseSchema,
      unique,
      references,
      fileFields,
      searchableFields,
      softDeleteEnabled,
      auditEnabled: s.audit !== false,
    };
  }

  function buildSwagger(s, model) {
    const path = s.path;
    const swaggerSchema = m2s(model);
    const postSchema = m2s(model, { omitFields: ['_id', 'createdAt', 'updatedAt'] });
    const putSchema = JSON.parse(JSON.stringify(postSchema));
    delete putSchema.required;
    swaggerSchema.type = 'object';

    // Computed / virtual fields aren't in the Mongoose model, so
    // mongoose-to-swagger can't see them. Inject each one with
    // `readOnly: true` so generated SDKs and humans both know the
    // field exists, that it's part of the response shape, and that
    // it can't be supplied on POST / PUT.
    const computedFieldNames = new Set();
    for (const f of computedFieldsOf(s)) {
      computedFieldNames.add(f.name);
      const swaggerType = computedSwaggerType(f.type);
      swaggerSchema.properties[f.name] = {
        ...swaggerType,
        readOnly: true,
        ...(f.description ? { description: f.description } : {}),
      };
    }

    const tag = path.charAt(0).toUpperCase() + path.slice(1);
    const collectionPath = `/api/${s.version}/${path}`;
    const itemPath = `/api/${s.version}/${path}/{id}`;

    apiSpec.definitions[path] = swaggerSchema;
    apiSpec.paths[collectionPath] = {
      post: {
        tags: [tag],
        consumes: ['application/json'],
        produces: ['application/json'],
        parameters: [{ in: 'body', name: 'body', required: true, schema: postSchema }],
        responses: { 201: { description: 'success', schema: { $ref: `#/definitions/${path}` } } },
      },
      get: {
        tags: [tag],
        consumes: ['application/json'],
        produces: ['application/json'],
        parameters: [
          // Filterable query params come from persisted fields only.
          // Computed/virtual fields are part of the response schema
          // (with readOnly: true) but advertising them here would be
          // misleading — they're derived at response time and Mongo
          // can't filter on a value that doesn't exist in the
          // collection. Same logic for File-field metadata sub-docs:
          // mongo-querystring on `attachment.size` etc. doesn't fit
          // the JSON-string filter contract these params describe.
          ...Object.keys(swaggerSchema.properties)
            .filter((sc) => !computedFieldNames.has(sc))
            .map((sc) => ({
              name: sc,
              in: 'query',
              type: 'string',
              description: 'mongo-querystring formatted query parameters',
            })),
          ...((s.fields || []).some((f) => f && f.searchable)
            ? [
                {
                  name: '__q',
                  in: 'query',
                  type: 'string',
                  description:
                    'Full-text search across all `searchable: true` fields. Pair with `__sort=score` to order by relevance.',
                },
              ]
            : []),
          ...(Object.keys(normalizeRelations(s)).length
            ? [
                {
                  name: '__include',
                  in: 'query',
                  type: 'string',
                  description:
                    'CSV of relation names to populate in a single round-trip per relation. ' +
                    `Allowed: ${Object.keys(normalizeRelations(s)).join(', ')}.`,
                },
              ]
            : []),
        ],
        responses: {
          200: {
            description: 'success',
            schema: { type: 'array', items: { $ref: `#/definitions/${path}` } },
          },
        },
      },
      put: {
        tags: [tag],
        consumes: ['application/json'],
        produces: ['application/json'],
        parameters: [
          {
            in: 'query',
            name: 'query',
            type: 'string',
            description: 'mongo-querystring formatted query parameters',
          },
          { in: 'body', name: 'body', required: true, schema: putSchema },
        ],
        responses: { 200: { description: 'success', schema: { $ref: `#/definitions/${path}` } } },
      },
    };
    const itemIncludeParams = Object.keys(normalizeRelations(s)).length
      ? [
          {
            name: '__include',
            in: 'query',
            type: 'string',
            description:
              'CSV of relation names to populate in a single round-trip per relation. ' +
              `Allowed: ${Object.keys(normalizeRelations(s)).join(', ')}.`,
          },
        ]
      : [];
    apiSpec.paths[itemPath] = {
      get: {
        tags: [tag],
        parameters: [
          { in: 'path', name: 'id', type: 'string', required: true },
          ...itemIncludeParams,
        ],
        responses: { 200: { description: 'success', schema: { $ref: `#/definitions/${path}` } } },
      },
      delete: {
        tags: [tag],
        parameters: [{ in: 'path', name: 'id', type: 'string', required: true }],
        responses: { 200: { description: 'success' } },
      },
      put: {
        tags: [tag],
        parameters: [
          { in: 'path', name: 'id', type: 'string', required: true },
          { in: 'body', name: 'body', schema: putSchema },
        ],
        responses: { 200: { description: 'success', schema: { $ref: `#/definitions/${path}` } } },
      },
    };

    // Per-File-field Swagger paths. Multipart contract is documented
    // under `consumes: multipart/form-data`; the form field name is
    // always `file`. maxBytes / accept constraints surface as the
    // description so generated SDKs and humans can see them.
    const fileSwaggerPaths = [];
    const fileFieldList = (Array.isArray(s.fields) ? s.fields : []).filter(
      (f) => f && f.type === 'File'
    );
    for (const ff of fileFieldList) {
      const cfg = ff.file || {};
      const filePath = `/api/${s.version}/${path}/{id}/${ff.name}`;
      const constraints = [];
      if (cfg.maxBytes) constraints.push(`maxBytes: ${cfg.maxBytes}`);
      if (Array.isArray(cfg.accept) && cfg.accept.length) {
        constraints.push(`accept: ${cfg.accept.join(', ')}`);
      }
      if (cfg.access) constraints.push(`access: ${cfg.access}`);
      const desc = `Upload, fetch, or delete the ${ff.name} file. ${constraints.join('; ')}`.trim();
      apiSpec.paths[filePath] = {
        post: {
          tags: [tag],
          consumes: ['multipart/form-data'],
          produces: ['application/json'],
          description: desc,
          parameters: [
            { in: 'path', name: 'id', type: 'string', required: true },
            {
              in: 'formData',
              name: 'file',
              type: 'file',
              required: true,
              description: 'Multipart upload payload',
            },
          ],
          responses: {
            201: {
              description: 'success',
              schema: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  url: { type: 'string' },
                  size: { type: 'integer' },
                  contentType: { type: 'string' },
                  originalName: { type: 'string' },
                },
              },
            },
            400: { description: 'oversize, disallowed mime, or missing file' },
            404: { description: 'record not found' },
          },
        },
        get: {
          tags: [tag],
          description: `Redirect (302) to the storage URL for ${ff.name}. ${cfg.access === 'private' ? 'Returns a short-lived signed URL.' : 'Returns the public URL.'}`,
          parameters: [{ in: 'path', name: 'id', type: 'string', required: true }],
          responses: {
            302: { description: 'redirect to storage URL' },
            404: { description: 'record or file not found' },
          },
        },
        delete: {
          tags: [tag],
          description: `Remove the ${ff.name} blob and clear the metadata.`,
          parameters: [{ in: 'path', name: 'id', type: 'string', required: true }],
          responses: { 204: { description: 'deleted' } },
        },
      };
      fileSwaggerPaths.push(filePath);
    }

    // Per-aggregation Swagger paths. Declared params surface as query
    // parameters so generated SDKs and humans see what's required.
    const aggregationSwaggerPaths = [];
    const aggregationList = Array.isArray(s.aggregations) ? s.aggregations : [];
    for (const agg of aggregationList) {
      if (!agg || typeof agg.name !== 'string' || !Array.isArray(agg.pipeline)) {
        continue;
      }
      const aggPath = `/api/${s.version}/${path}/aggregations/${agg.name}`;
      const swaggerParams = Object.entries(agg.params || {}).map(
        ([paramName, def]) => ({
          name: paramName,
          in: 'query',
          type:
            def.type === 'number'
              ? 'number'
              : def.type === 'boolean'
              ? 'boolean'
              : 'string',
          required: !!def.required,
          description: def.description || `${def.type} parameter`,
        })
      );
      apiSpec.paths[aggPath] = {
        get: {
          tags: [tag],
          description: agg.description || `Aggregation ${agg.name} on ${path}`,
          parameters: swaggerParams,
          responses: {
            200: {
              description: 'aggregation results',
              schema: {
                type: 'array',
                items: { type: 'object' },
              },
            },
            400: { description: 'parameter validation or unsafe-stage rejection' },
          },
        },
      };
      aggregationSwaggerPaths.push(aggPath);
    }

    return {
      collectionPath,
      itemPath,
      schemaPath: `${collectionPath}-schema`,
      fileSwaggerPaths,
      aggregationSwaggerPaths,
    };
  }

  function buildRestRouter(s, model, references, mongooseSchema, fileFields, searchableFields, opts = {}) {
    const softDeleteEnabled = opts.softDeleteEnabled !== false;
    const auditEnabled = opts.auditEnabled !== false;
    // Compile the schema's `relations` map (and any legacy
    // `field.reference` shorthand) once per load. The handler-side
    // `__include` parsing reuses this normalized form on every
    // request — handlers don't re-walk the schema each time.
    const normalizedRelations = normalizeRelations(s);
    const relationNames = Object.keys(normalizedRelations);
    // Computed-field context factory. The handler-level callers
    // build a fresh ctx per request so `ctx.user` always reflects
    // the current caller and cross-resource lookups (`ctx.find`,
    // `ctx.count`) read against the live registry.
    const buildComputedContextForReq = (req) =>
      buildComputedContext({
        user: req.user,
        req,
        getResource: (p) => getResource(p, s.version),
      });

    // Per-schema idempotency middleware. The `getBodyForHash` callback
    // mirrors what the create handler will actually persist
    // (filterWritable + tenant stamping) so two retries that produce
    // the same database write hash the same way — without this, an
    // ACL-stripped or unknown-field difference between retries would
    // fire a false IDEMPOTENCY_CONFLICT. Wrapped in asyncHandler so
    // any rejection routes through the centralised errorHandler.
    const idempotencyMiddleware = asyncHandler(
      buildIdempotency({
        getBodyForHash: (req) => {
          const writable = filterWritable(req.body, s, req.user, 'create');
          return {
            ...writable,
            accountId: req.user && req.user.user_id,
            userId: req.user && req.user.user_id,
          };
        },
      })
    );
    /**
     * Given the standard ownership query, layer in deletedAt
     * filtering. By default reads exclude tombstoned docs; the
     * caller can pass __includeDeleted=true to see them.
     */
    const applySoftDeleteFilter = (q, req) => {
      if (!softDeleteEnabled) return q;
      const includeDeleted = req && req.query && req.query.__includeDeleted === 'true';
      if (includeDeleted) return q;
      return { ...q, deletedAt: null };
    };
    const audit = (entry) => {
      if (!auditEnabled) return;
      return recordAudit({ ...entry, resource: s.path });
    };
    const router = express.Router();
    const path = s.path;
    const PAGE_SIZE = process.env.PAGE_SIZE;
    const storage = getStorageDriver();

    // Auth + API-key scope stacks. Reads gate on 'read', writes
    // (POST / PUT / DELETE) on 'write'. requireScope is a no-op for
    // JWT and X-Client-Id callers (they carry no scopes array) — only
    // scope-limited API keys are constrained. auth(true) runs first so
    // req.user is populated before the scope check.
    const authRead = [auth(true), requireScope('read')];
    const authWrite = [auth(true), requireScope('write')];

    // Per-File-field upload / download / delete routes. Multer is
    // configured per-field so maxBytes and accept apply at parse time.
    for (const ff of fileFields || []) {
      const fieldName = ff.name;
      const cfg = ff.file || {};
      const maxBytes = cfg.maxBytes || 10 * 1024 * 1024; // 10MB default
      const accept = Array.isArray(cfg.accept) ? cfg.accept : null;
      const access = cfg.access || 'public';

      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxBytes },
        fileFilter: (req, file, cb) => {
          if (accept && !matchAccept(file.mimetype, accept)) {
            return cb(new ValidationError(`File type ${file.mimetype} not allowed for ${fieldName}`));
          }
          cb(null, true);
        },
      });

      // POST upload → stores blob, sets the File metadata sub-doc on
      // the record. Owner-only.
      router.post(
        `/api/${s.version}/${path}/:id/${fieldName}`,
        authWrite,
        (req, res, next) => upload.single('file')(req, res, (err) => {
          // multer's MulterError wraps size limit etc.; surface as
          // ValidationError so errorHandler returns 400.
          if (err && err.code === 'LIMIT_FILE_SIZE') {
            return next(new ValidationError(`File exceeds ${maxBytes} bytes`));
          }
          if (err) return next(err);
          next();
        }),
        asyncHandler(async (req, res) => {
          if (!req.file) throw new ValidationError('multipart field "file" required');
          // File-field mutations always exclude tombstones — soft-
          // deleted records aren't writable through any HTTP path.
          const baseOwner = bypassUserScopeForList(s, req.user)
            ? { _id: req.params.id }
            : { _id: req.params.id, userId: req.user.user_id };
          const ownerQuery = softDeleteEnabled ? { ...baseOwner, deletedAt: null } : baseOwner;
          const record = await model.findOne(ownerQuery);
          if (!record) throw new NotFoundError(path);

          // Generate a key prefixed with the access mode so the local
          // serve route can decide whether to require a signed URL
          // by inspecting the key alone:
          //   public/<path>/<id>/<field>/<uuid>-<name>
          //   private/<path>/<id>/<field>/<uuid>-<name>
          const safeName = req.file.originalname.replace(/[^A-Za-z0-9._-]+/g, '_');
          const accessPrefix = access === 'private' ? 'private' : 'public';
          const key = `${accessPrefix}/${path}/${record._id}/${fieldName}/${crypto.randomUUID()}-${safeName}`;

          // Order matters: write the new blob FIRST, then save the
          // record, then best-effort cleanup of the old blob. If the
          // put fails, the old key is still referenced and serveable.
          // If the save fails after a successful put, we orphan the
          // new blob (but compensate immediately below).
          await storage.put(key, req.file.buffer, { contentType: req.file.mimetype });

          const meta = {
            key,
            bucket: storage.bucket || null,
            size: req.file.size,
            contentType: req.file.mimetype,
            originalName: req.file.originalname,
            uploadedAt: new Date(),
          };

          const previous = record.get(fieldName);
          record.set(fieldName, meta);
          try {
            await record.save();
          } catch (saveErr) {
            // Compensate: remove the newly-uploaded blob so we don't
            // leak orphan storage when the DB write fails.
            try { await storage.remove(key); } catch (_) {}
            throw saveErr;
          }

          if (previous && previous.key && previous.key !== key) {
            try {
              await storage.remove(previous.key);
            } catch (cleanupErr) {
              logger.warn(
                { err: cleanupErr, oldKey: previous.key },
                'failed to remove previous file blob; orphan left in storage'
              );
            }
          }

          const decorated = await decorateFileUrls(
            JSON.parse(JSON.stringify(record)),
            s,
            storage
          );
          emitRecordEvent({
            type: `${path}.updated`,
            version: s.version,
            userId: String(req.user.user_id),
            recordId: String(record._id),
            record: projectByAcl(decorated, s, req.user),
            req: buildReqMeta(req),
          });
          res.status(201).json(decorated[fieldName]);
        })
      );

      // GET download → for public access, redirect to publicUrl. For
      // private, redirect to a short-lived signed URL. The local
      // driver's signed URL points at /_files/...; the s3 driver's at
      // S3 directly.
      router.get(
        `/api/${s.version}/${path}/:id/${fieldName}`,
        authRead,
        asyncHandler(async (req, res) => {
          const baseOwner = bypassUserScopeForList(s, req.user)
            ? { _id: req.params.id }
            : { _id: req.params.id, userId: req.user.user_id };
          const scopedOwner = applyRoleScopeFilter(
            baseOwner,
            getRoleScopeFilter(s, req.user)
          );
          const ownerQuery = softDeleteEnabled ? { ...scopedOwner, deletedAt: null } : scopedOwner;
          const record = await model.findOne(ownerQuery).lean();
          if (!record) throw new NotFoundError(path);
          const meta = record[fieldName];
          if (!meta || !meta.key) throw new NotFoundError(`${path}.${fieldName}`);
          const url =
            access === 'private'
              ? await storage.signedUrl(meta.key)
              : storage.publicUrl(meta.key);
          res.redirect(302, url);
        })
      );

      // DELETE the blob and clear the metadata sub-doc on the record.
      router.delete(
        `/api/${s.version}/${path}/:id/${fieldName}`,
        authWrite,
        asyncHandler(async (req, res) => {
          const baseOwner = bypassUserScopeForDelete(s, req.user)
            ? { _id: req.params.id }
            : { _id: req.params.id, userId: req.user.user_id };
          const ownerQuery = softDeleteEnabled ? { ...baseOwner, deletedAt: null } : baseOwner;
          const record = await model.findOne(ownerQuery);
          if (!record) throw new NotFoundError(path);
          const meta = record.get(fieldName);
          if (!meta || !meta.key) {
            return res.status(204).end();
          }
          try { await storage.remove(meta.key); } catch (_) {}
          record.set(fieldName, null);
          await record.save();
          res.status(204).end();
        })
      );
    }

    router.get(
      `/api/${s.version}/${path}-schema`,
      authRead,
      asyncHandler(async (req, res) => {
        const jsSchema = mongooseSchema.jsonSchema();
        ['_id', 'createdAt', 'updatedAt', '__v'].forEach((k) => {
          delete jsSchema.properties[k];
        });
        // Computed fields aren't in the Mongoose model, so
        // jsonSchema() omits them. Inject each one as `readOnly:
        // true` so introspecting clients see the full response
        // shape.
        for (const f of computedFieldsOf(s)) {
          jsSchema.properties[f.name] = {
            ...computedSwaggerType(f.type),
            readOnly: true,
            ...(f.description ? { description: f.description } : {}),
          };
        }
        res.status(200).send(jsSchema);
      })
    );

    router.post(
      `/api/${s.version}/${path}`,
      authWrite,
      idempotencyMiddleware,
      asyncHandler(async (req, res) => {
        const writable = filterWritable(req.body, s, req.user, 'create');
        let data = {
          ...writable,
          accountId: req.user.user_id,
          userId: req.user.user_id,
        };
        // State-machine fields: clients can't pick a non-initial
        // state on create. Always stamp the declared initial after
        // filterWritable so a forged `{ status: 'approved' }` doesn't
        // bypass the transition graph.
        stampInitialStates(data, s);
        // beforeCreate runs after server-side stamping so the hook
        // sees (and can override) the final persisted shape. Throws
        // reject the request via errorHandler.
        data = await runBeforeHook(s, 'beforeCreate', {
          input: data,
          user: req.user,
          req,
        });
        // Re-stamp tenant fields after the hook so a beforeCreate
        // that returned `{ ...input, userId: 'attacker' }` cannot
        // move the new record into another tenant. Ownership is
        // strictly server-controlled.
        stampTenantFields(data, req.user);
        const record = await model.create(data);
        const plain = JSON.parse(JSON.stringify(record));
        await decorateFileUrls(plain, s, storage);
        await applyComputed([plain], s, buildComputedContextForReq(req));
        attachAvailableTransitions([plain], s, req.user);
        await audit({
          req,
          recordId: record._id,
          action: 'create',
          before: null,
          after: plain,
        });
        // Webhook payloads must NOT carry ACL-restricted fields: a
        // subscriber whose roles can't read `salary` shouldn't see it
        // delivered through this side channel either.
        const projected = projectByAcl(plain, s, req.user);
        emitRecordEvent({
          type: `${path}.created`,
          version: s.version,
          userId: req.user.user_id,
          recordId: String(record._id),
          record: projected,
          before: null,
          after: projected,
          req: buildReqMeta(req),
        });
        await runAfterHook(
          s,
          'afterCreate',
          { record: projected, user: req.user, req },
          req.log || logger
        );
        res.status(201).json(projected);
      })
    );

    router.get(
      `/api/${s.version}/${path}`,
      authRead,
      asyncHandler(async (req, res) => {
        const pageSize = parseInt(PAGE_SIZE);
        const page = parseInt(req.query.__page) || 1;
        const sort = req.query.__sort || false;
        const q = req.query.__q;
        const sortObject = {};
        let projection = null;
        const hasSearchable = Array.isArray(searchableFields) && searchableFields.length > 0;
        if (sort) {
          const [k, dir] = sort.split(':');
          if (k === 'score' && q && hasSearchable) {
            // Special case: order by full-text relevance. Mongo
            // requires the score to be projected before it can be
            // used in $sort, AND requires $text in the query — both
            // conditions are tied to the schema actually having
            // searchable fields. Non-searchable schemas silently
            // drop the score sort along with __q.
            sortObject.score = { $meta: 'textScore' };
            projection = { score: { $meta: 'textScore' } };
          } else if (k !== 'score') {
            sortObject[k] = dir;
          }
          // (k === 'score' with no searchable / no __q falls through
          // to no sort; that matches the permissive __q semantics.)
        }
        const querystring = { ...req.query };
        Object.keys(req.query).forEach((qq) => {
          if (qq.startsWith('__')) delete querystring[qq];
        });
        let query = qs.parse(querystring);
        // Bypass the userId scope for callers whose roles match
        // schema.acl.list. Otherwise default ownership applies.
        if (!bypassUserScopeForList(s, req.user)) {
          query['userId'] = req.user.user_id;
        }
        // Apply schema.acl.scope[role] for any role the caller holds —
        // a server-controlled filter the caller cannot widen via their
        // own query (e.g. storefront role limited to `{ published:
        // true }` on the product collection).
        query = applyRoleScopeFilter(query, getRoleScopeFilter(s, req.user));
        // Full-text search: only valid when the schema has at least
        // one searchable field. The framework owns the text index;
        // schemas without one quietly ignore __q to keep the surface
        // permissive.
        if (q && hasSearchable) {
          query.$text = { $search: String(q) };
        }
        // Soft-delete: exclude tombstones unless __includeDeleted=true.
        query = applySoftDeleteFilter(query, req);

        const findQuery = model.find(query, projection);
        const [list, count] = await Promise.all([
          findQuery
            .sort(sortObject)
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .lean(),
          model.find(query).countDocuments(),
        ]);

        await decorateListFileUrls(list, s, storage);

        // __include population: parse + validate, then batch-load each
        // relation in a single round-trip. Validation runs even if no
        // includes are requested so a typo on an unknown relation
        // never silently no-ops.
        const includes = parseIncludes(req.query.__include, normalizedRelations);
        if (includes.length) {
          await applyIncludes(list, normalizedRelations, includes, {
            user: req.user,
            getResource: (p) => getResource(p, s.version),
          });
        }
        // Computed fields: derived per-record at response time.
        // Runs after relations so a computed function can reference
        // included relation values on `record`.
        await applyComputed(list, s, buildComputedContextForReq(req));
        attachAvailableTransitions(list, s, req.user);

        const totalPages = Math.ceil(count / pageSize);
        const result = {
          results: projectListByAcl(list, s, req.user),
          totalResults: count,
          page,
          perPage: pageSize,
          totalPages,
        };
        if (totalPages > page) result.nextPage = page + 1;
        if (page > 1) result.prevPage = page - 1;
        res.status(200).json(result);
      })
    );

    router.put(
      `/api/${s.version}/${path}`,
      authWrite,
      asyncHandler(async (req, res) => {
        // The query predicate doubles as the create-time payload on
        // upsert (Mongo seeds new docs with the predicate's equality
        // keys). Filter the client-provided keys through
        // filterWritable('create') first so ACL-create-restricted
        // fields can't be smuggled in via the query string, THEN stamp
        // tenant fields so tenant isolation is non-bypassable.
        const rawQuery = qs.parse(req.query);
        const filteredQuery = filterWritable(rawQuery, s, req.user, 'create');
        // Only stamp `accountId` when the schema declares it as a
        // field — Mongoose's strict mode throws on upsert when the
        // filter references a path the schema doesn't know about
        // ("Path 'accountId' is not in schema, strict mode is true,
        // and upsert is true"). `userId` is universal in dAvePi
        // schemas by convention, so it's always stamped.
        const schemaHasAccountId = Array.isArray(s.fields)
          && s.fields.some((f) => f.name === 'accountId');
        const safeQuery = {
          ...filteredQuery,
          userId: req.user.user_id,
          ...(schemaHasAccountId ? { accountId: req.user.user_id } : {}),
          // Bulk PUT must NOT touch tombstones — soft-deleted records
          // are read-only at the API layer until restored. Without
          // this constraint, an unsuspecting `?accountName=X` could
          // resurrect (or upsert via) a tombstoned doc.
          ...(softDeleteEnabled ? { deletedAt: null } : {}),
        };
        // `$set` must never include tenant fields. The matched docs
        // are already owner-scoped, and upserted docs get ownership
        // from `safeQuery`. Including userId/accountId in $set would
        // either be a no-op (same values) or — if a malicious body
        // somehow reintroduced them past filterWritable — a tenant
        // rewrite. filterWritable already strips them; this is
        // belt-and-suspenders.
        const writable = stripTenantFields(
          filterWritable(req.body, s, req.user, 'update')
        );
        const record = await model.updateMany(
          safeQuery,
          { $set: writable },
          { upsert: true }
        );
        emitRecordEvent({
          type: `${path}.updated`,
          version: s.version,
          userId: req.user.user_id,
          filter: safeQuery,
          numAffected: record.modifiedCount + (record.upsertedCount || 0),
          req: buildReqMeta(req),
        });
        res.status(200).json(record);
      })
    );

    router.get(
      `/api/${s.version}/${path}/:id`,
      authRead,
      asyncHandler(async (req, res) => {
        const baseQuery = bypassUserScopeForList(s, req.user)
          ? { _id: req.params.id }
          : { userId: req.user.user_id, _id: req.params.id };
        const scoped = applyRoleScopeFilter(
          baseQuery,
          getRoleScopeFilter(s, req.user)
        );
        const query = applySoftDeleteFilter(scoped, req);
        const record = await model.findOne(query);
        if (!record) throw new NotFoundError(path);

        const copy = JSON.parse(JSON.stringify(record));
        await decorateFileUrls(copy, s, storage);

        // __include drives relation population for both single and
        // list reads, replacing the legacy `references` populate
        // loop. Tenant isolation is re-applied per relation inside
        // applyIncludes, never trusting the parent record's tenancy
        // alone.
        const includes = parseIncludes(req.query.__include, normalizedRelations);
        if (includes.length) {
          await applyIncludes([copy], normalizedRelations, includes, {
            user: req.user,
            getResource: (p) => getResource(p, s.version),
          });
        }
        await applyComputed([copy], s, buildComputedContextForReq(req));
        attachAvailableTransitions([copy], s, req.user);

        res.status(200).json(projectByAcl(copy, s, req.user));
      })
    );

    router.delete(
      `/api/${s.version}/${path}/:id`,
      authWrite,
      asyncHandler(async (req, res) => {
        const baseQuery = bypassUserScopeForDelete(s, req.user)
          ? { _id: req.params.id }
          : { userId: req.user.user_id, _id: req.params.id };

        if (softDeleteEnabled) {
          // Soft delete: pre-fetch the record (only those NOT already
          // tombstoned), set deletedAt, leave file blobs in place so
          // restore is reversible. Audit captures before/after.
          const existing = await model
            .findOne({ ...baseQuery, deletedAt: null })
            .lean();
          if (!existing) throw new NotFoundError(path);
          await runBeforeHook(s, 'beforeDelete', {
            input: null,
            current: existing,
            user: req.user,
            req,
          });
          const now = new Date();
          await model.updateOne(
            { _id: existing._id },
            { $set: { deletedAt: now } }
          );
          // Post-persist view of the record. Audit, the afterDelete
          // hook, and any future consumer that needs the
          // "as-committed" shape all build off the same projection
          // so a hook author can rely on `record.deletedAt` being
          // set to the actual tombstone timestamp.
          const tombstoned = { ...existing, deletedAt: now };
          await audit({
            req,
            recordId: existing._id,
            action: 'delete',
            before: existing,
            after: tombstoned,
          });
          emitRecordEvent({
            type: `${path}.deleted`,
            version: s.version,
            userId: req.user.user_id,
            recordId: String(req.params.id),
            // `record` is the legacy payload key the webhook dispatcher
            // serializes onto outbound deliveries; it stayed undefined
            // when we added `before` / `after`, which broke webhook
            // consumers (their payload's `record` came through as
            // `undefined`). The tombstoned projection is the right
            // shape — same as the audit row's `after`.
            record: projectByAcl(tombstoned, s, req.user),
            before: projectByAcl(existing, s, req.user),
            after: projectByAcl(tombstoned, s, req.user),
            req: buildReqMeta(req),
          });
          await runAfterHook(
            s,
            'afterDelete',
            {
              record: projectByAcl(tombstoned, s, req.user),
              user: req.user,
              req,
            },
            req.log || logger
          );
          return res.status(200).json({ acknowledged: true, deletedCount: 1, softDeleted: true });
        }

        // Hard-delete path (schemas with softDelete: false).
        const existing = (fileFields && fileFields.length)
          ? await model.findOne(baseQuery).lean()
          : await model.findOne(baseQuery).lean();
        if (s.hooks && s.hooks.beforeDelete) {
          if (!existing) throw new NotFoundError(path);
          await runBeforeHook(s, 'beforeDelete', {
            input: null,
            current: existing,
            user: req.user,
            req,
          });
        }
        const result = await model.deleteOne(baseQuery);
        if (!result.deletedCount) throw new NotFoundError(path);
        if (existing && fileFields && fileFields.length) {
          for (const ff of fileFields) {
            const meta = existing[ff.name];
            if (meta && meta.key) {
              try { await storage.remove(meta.key); } catch (_) {}
            }
          }
        }
        await audit({
          req,
          recordId: existing && existing._id,
          action: 'delete',
          before: existing,
          after: null,
        });
        emitRecordEvent({
          type: `${path}.deleted`,
          version: s.version,
          userId: req.user.user_id,
          recordId: String(req.params.id),
          // Legacy `record` payload key for the webhook dispatcher.
          // Hard-delete has no post-state, so the pre-delete projection
          // is the most useful snapshot to deliver — consumers expect
          // SOMETHING under `record` on a delete event.
          record: existing ? projectByAcl(existing, s, req.user) : null,
          before: existing ? projectByAcl(existing, s, req.user) : null,
          after: null,
          req: buildReqMeta(req),
        });
        await runAfterHook(
          s,
          'afterDelete',
          {
            record: existing ? projectByAcl(existing, s, req.user) : null,
            user: req.user,
            req,
          },
          req.log || logger
        );
        res.status(200).json(result);
      })
    );

    if (softDeleteEnabled) {
      router.post(
        `/api/${s.version}/${path}/:id/restore`,
        authWrite,
        asyncHandler(async (req, res) => {
          const baseQuery = bypassUserScopeForDelete(s, req.user)
            ? { _id: req.params.id }
            : { userId: req.user.user_id, _id: req.params.id };
          const existing = await model
            .findOne({ ...baseQuery, deletedAt: { $ne: null } })
            .lean();
          if (!existing) throw new NotFoundError(path);
          await model.updateOne(
            { _id: existing._id },
            { $set: { deletedAt: null } }
          );
          await audit({
            req,
            recordId: existing._id,
            action: 'restore',
            before: existing,
            after: { ...existing, deletedAt: null },
          });
          res.status(204).end();
        })
      );
    }

    router.get(
      `/api/${s.version}/${path}/:id/history`,
      authRead,
      asyncHandler(async (req, res) => {
        const pageSize = parseInt(PAGE_SIZE);
        const page = parseInt(req.query.__page) || 1;
        // Authorization: must be able to read the record (deleted or
        // not). Bypass for acl.list roles, otherwise the caller must
        // own the record. Role-scope filter is applied on top so a
        // role with acl.list bypass still cannot see history for
        // records outside its acl.scope predicate — without this the
        // history endpoint would be an alternate read surface that
        // leaks before/after/diff for out-of-scope records.
        const baseOwner = bypassUserScopeForList(s, req.user)
          ? { _id: req.params.id }
          : { _id: req.params.id, userId: req.user.user_id };
        const ownerQuery = applyRoleScopeFilter(
          baseOwner,
          getRoleScopeFilter(s, req.user)
        );
        const exists = await model.findOne(ownerQuery).select('_id').lean();
        if (!exists) throw new NotFoundError(path);

        const auditQuery = { resource: s.path, recordId: req.params.id };
        const [list, count] = await Promise.all([
          AuditLog.find(auditQuery)
            .sort({ createdAt: -1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .lean(),
          AuditLog.countDocuments(auditQuery),
        ]);
        // Apply field-level read ACL to every audit entry. Without
        // this the history endpoint would expose ACL-restricted
        // fields (e.g. salary) via before/after/diff that
        // projectByAcl would otherwise hide on the regular GET path.
        const fieldByName = new Map(
          (s.fields || []).map((f) => [f.name, f])
        );
        const allowedDiffKey = (k) => {
          const f = fieldByName.get(k);
          if (!f || !f.acl || !f.acl.read) return true;
          // hasOverlap-style check inlined: keep the diff key if the
          // caller has at least one of the field's `read` roles.
          const userRolesArr = Array.isArray(req.user.roles) && req.user.roles.length
            ? req.user.roles
            : ['user'];
          return f.acl.read.some((r) => userRolesArr.includes(r));
        };
        const projected = list.map((entry) => ({
          ...entry,
          before: entry.before ? projectByAcl(entry.before, s, req.user) : entry.before,
          after: entry.after ? projectByAcl(entry.after, s, req.user) : entry.after,
          diff: entry.diff
            ? Object.fromEntries(
                Object.entries(entry.diff).filter(([k]) => allowedDiffKey(k))
              )
            : entry.diff,
        }));
        const totalPages = Math.ceil(count / pageSize);
        const result = {
          results: projected,
          totalResults: count,
          page,
          perPage: pageSize,
          totalPages,
        };
        if (totalPages > page) result.nextPage = page + 1;
        if (page > 1) result.prevPage = page - 1;
        res.status(200).json(result);
      })
    );

    router.put(
      `/api/${s.version}/${path}/:id`,
      authWrite,
      asyncHandler(async (req, res) => {
        // Updates stay strictly owner-bound. acl.list grants read
        // visibility; the spec doesn't define a write-bypass slot, so
        // only the record's owner may PUT regardless of role.
        const query = applySoftDeleteFilter(
          { userId: req.user.user_id, _id: req.params.id },
          req
        );
        let writable = filterWritable(req.body, s, req.user, 'update');
        // We need the `before` snapshot whenever audit is on OR
        // there's a state-machine field whose validation needs the
        // current value OR a beforeUpdate / afterUpdate hook is
        // declared (the hook receives the `current` document). Fetch
        // once so we don't double-read.
        const hasStateMachine = stateMachineFieldsOf(s).length > 0;
        const hasUpdateHook = Boolean(
          (s.hooks && (s.hooks.beforeUpdate || s.hooks.afterUpdate))
        );
        const before = (auditEnabled || hasStateMachine || hasUpdateHook)
          ? await model.findOne(query).lean()
          : null;

        // beforeUpdate runs after filterWritable so the hook sees
        // the post-ACL payload and can mutate it before persist.
        // Throws reject the request via errorHandler. The hook runs
        // BEFORE state-machine validation so a hook that rewrites a
        // transition target (e.g. routes 'review' → 'rejected'
        // because of business rules) still gets validated by the
        // FSM below.
        if (s.hooks && s.hooks.beforeUpdate) {
          if (!before) throw new NotFoundError(path);
          writable = await runBeforeHook(s, 'beforeUpdate', {
            input: writable,
            current: before,
            user: req.user,
            req,
          });
        }
        // `$set` must never include tenant fields. The record being
        // updated is already ownership-scoped by `query` above, so
        // userId/accountId are already correct on disk. Including
        // them in $set is either a no-op (same values) or — if a
        // hook returned `{ ...input, userId: 'attacker' }` — a
        // tenant-rewrite attack. Strip them here, after the hook,
        // as the canonical enforcement site.
        stripTenantFields(writable);

        // Validate every state-machine transition the client is
        // attempting BEFORE we touch the record. An invalid
        // transition is a structured 400 with current / attempted /
        // allowed in the body so the client can render actionable
        // next-steps.
        const transitions = hasStateMachine
          ? listTransitionsToValidate(writable, before, s)
          : [];
        // 404 short-circuit: if the caller is attempting a
        // state-machine transition on a record that doesn't exist,
        // surface NOT_FOUND rather than letting validateTransition
        // misinterpret the absent `current` as
        // `initial_state_required` (a 400 INVALID_TRANSITION).
        if (transitions.length && !before) {
          throw new NotFoundError(path);
        }
        for (const t of transitions) {
          const v = validateTransition(t.field, t.current, t.next);
          if (!v.valid) {
            throw new InvalidTransitionError(v.message, {
              field: t.field.name,
              current: v.current,
              attempted: v.attempted,
              allowed: v.allowed,
              reason: v.reason,
            });
          }
        }

        let result;
        if (Object.keys(writable).length === 0) {
          // Empty $set is a no-op in Mongoose (matchedCount=0 even
          // when the doc exists). Verify the record exists for the
          // 404 semantics, then return a synthetic OK so callers who
          // posted only ACL-stripped or File-field keys don't see a
          // misleading 404.
          const exists = await model.findOne(query).select('_id').lean();
          if (!exists) throw new NotFoundError(path);
          result = { acknowledged: true, matchedCount: 1, modifiedCount: 0 };
        } else {
          result = await model.updateOne(query, { $set: writable });
          if (!result.matchedCount) throw new NotFoundError(path);
        }
        // Fetch the post-update snapshot once and re-use it for audit,
        // the bus event, and afterUpdate. Three consumers all wanted
        // their own findById; one read is enough.
        const afterDoc = before
          ? await model.findById(req.params.id).lean()
          : null;
        if (auditEnabled && before) {
          await audit({
            req,
            recordId: req.params.id,
            action: 'update',
            before,
            after: afterDoc,
          });
        }
        // Project once and reuse: the bus event, the webhook dispatcher
        // (via `record`), and the afterUpdate hook all want the same
        // ACL-filtered shape — `projectByAcl` is the single source of
        // truth for "what's safe to deliver via a side channel".
        const projectedAfter = afterDoc ? projectByAcl(afterDoc, s, req.user) : null;
        const projectedBefore = before ? projectByAcl(before, s, req.user) : null;
        emitRecordEvent({
          type: `${path}.updated`,
          version: s.version,
          userId: req.user.user_id,
          recordId: String(req.params.id),
          // Legacy `record` payload key for the webhook dispatcher.
          // `record` was unset on update events while `before`/`after`
          // were introduced for the audit plugin; that turned every
          // outbound updated-event delivery's `record` into JSON
          // `undefined`. Restored — same projection as `after`.
          record: projectedAfter,
          before: projectedBefore,
          after: projectedAfter,
          req: buildReqMeta(req),
        });
        if (s.hooks && s.hooks.afterUpdate) {
          await runAfterHook(
            s,
            'afterUpdate',
            {
              record: projectedAfter,
              previous: before,
              user: req.user,
              req,
            },
            req.log || logger
          );
        }

        // Per-transition tail: audit row, dedicated event, and the
        // optional onEnter hook. All three are best-effort — a
        // failed audit / hook / event must not roll back a
        // successful state change.
        if (transitions.length) {
          const fresh = afterDoc;
          for (const t of transitions) {
            if (auditEnabled) {
              await audit({
                req,
                recordId: req.params.id,
                action: 'transition',
                before: { ...(before || {}), [t.field.name]: t.current },
                after: { ...(fresh || {}), [t.field.name]: t.next },
              });
            }
            emitRecordEvent({
              type: `${path}.transitioned`,
              version: s.version,
              userId: req.user.user_id,
              recordId: String(req.params.id),
              field: t.field.name,
              from: t.current,
              to: t.next,
              // `record` / `before` / `after` ride the same projection
              // contract every other single-record event uses — raw DB
              // snapshots here would leak ACL-restricted fields (e.g.
              // `salary`) to webhook subscribers and the audit plugin.
              // We deliberately don't re-stamp `[t.field.name]` after
              // projection: if projectByAcl stripped the state field
              // because the caller can't read it, re-injecting the
              // value would reintroduce the leak it just guarded.
              // Consumers that need the transition value still have
              // `field` / `from` / `to` on the event.
              record: projectedAfter,
              before: projectedBefore,
              after: projectedAfter,
              req: buildReqMeta(req),
            });
            const onEnterHooks =
              (t.field.stateMachine && t.field.stateMachine.onEnter) || {};
            const hook = onEnterHooks[t.next];
            if (typeof hook === 'function') {
              try {
                await hook(fresh, {
                  user: req.user,
                  req,
                  from: t.current,
                  to: t.next,
                });
              } catch (err) {
                (req.log || logger).warn(
                  { err, field: t.field.name, to: t.next },
                  'state-machine onEnter hook threw; transition committed anyway'
                );
              }
            }
          }
        }

        res.status(200).json(result);
      })
    );

    // Per-aggregation REST endpoints. Each schema can declare:
    //   aggregations: [
    //     { name: 'totalsByMonth', pipeline: [...], params: {...},
    //       cache: { ttlSeconds: 60 }, unsafe: false }
    //   ]
    // Each entry produces GET /api/{v}/{path}/aggregations/{name}.
    for (const agg of (s.aggregations || [])) {
      if (!agg || typeof agg.name !== 'string' || !Array.isArray(agg.pipeline)) {
        logger.warn(
          { schema: s.path, agg: agg && agg.name },
          'aggregation declaration missing name or pipeline; skipping'
        );
        continue;
      }
      router.get(
        `/api/${s.version}/${path}/aggregations/${agg.name}`,
        authRead,
        asyncHandler(async (req, res) => {
          const result = await runAggregation({
            agg,
            schema: s,
            model,
            user: req.user,
            rawParams: req.query,
          });
          if (result.cacheStatus) {
            res.setHeader('X-davepi-Aggregation-Cache', result.cacheStatus);
          }
          res.status(200).json(result.data);
        })
      );
    }

    return router;
  }

  /**
   * Shared aggregation runner used by both REST and GraphQL paths so
   * the safety / param / cache rules stay consistent across surfaces.
   *
   * Returns `{ data, cacheStatus }` where `cacheStatus` is `'hit'`,
   * `'miss'`, or `null` when caching is disabled for this aggregation.
   */
  async function runAggregation({ agg, schema, model, user, rawParams }) {
    let castedParams;
    try {
      castedParams = validateAndCastParams(agg.params, rawParams);
    } catch (err) {
      if (err instanceof AggregationParamError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }

    // Cache key includes userId so cross-tenant cache hits are
    // impossible. ttlSeconds <= 0 (or absent) opts out of caching.
    const cacheTtl =
      agg.cache && Number.isFinite(agg.cache.ttlSeconds) && agg.cache.ttlSeconds > 0
        ? agg.cache.ttlSeconds
        : 0;
    const cacheKey =
      cacheTtl > 0
        ? aggregationCache.key({
            resource: schema.path,
            name: agg.name,
            userId: user.user_id,
            params: castedParams,
          })
        : null;
    if (cacheKey) {
      const cached = aggregationCache.get(cacheKey);
      if (cached !== undefined) return { data: cached, cacheStatus: 'hit' };
    }

    let pipeline;
    try {
      pipeline = buildPipeline(agg, { userId: user.user_id, params: castedParams });
    } catch (err) {
      if (err instanceof AggregationSafetyError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }

    const results = await model.aggregate(pipeline);
    if (cacheKey) {
      aggregationCache.set(cacheKey, results, cacheTtl);
      return { data: results, cacheStatus: 'miss' };
    }
    return { data: results, cacheStatus: null };
  }

  /**
   * Rebuild the GraphQL schema from scratch (across all registered
   * schemas) and swap Apollo's middleware. Done end-to-end on every
   * load/unload because graphql-compose's type registry is global —
   * keeping the registry consistent on partial unload would require
   * tracking every type composeWithMongoose creates per schema and
   * deleting them individually.
   *
   * Order: build the new server, swap the indirection reference, then
   * stop the old server. Stopping first would leave the indirection
   * pointing at a dead router during the rebuild window.
   */
  async function rebuildGraphQL() {
    const composer = new mongoSc.SchemaComposer();
    const queryFields = {};
    const mutationFields = {};

    // Aggregation results have a dynamic shape (whatever the user's
    // pipeline produces), so we expose them through a JSON scalar
    // instead of synthesising an output type per aggregation. The
    // scalar is added once per rebuild — every aggregation query
    // references the same instance.
    const jsonScalar = composer.createScalarTC({
      name: 'AggregationJSON',
      description: 'Arbitrary JSON value emitted by an aggregation pipeline.',
      serialize: (v) => v,
      parseValue: (v) => v,
      parseLiteral: () => null,
    });

    // Two-pass build: compose every schema's TC FIRST, so the
    // relation pass below can resolve cross-schema references. A
    // single-pass loop would force relation thunks to look up TCs that
    // graphql-compose hasn't created yet, and `addRelation` reads the
    // target's output type at schema-build time — not lazily.
    const tcByPath = new Map();
    for (const entry of registry.values()) {
      const { schema: s, model } = entry;
      const tc = mongoGql.composeWithMongoose(model, { schemaComposer: composer });
      // Computed / virtual fields aren't in the Mongoose model, so
      // graphql-compose-mongoose doesn't see them. Wire each one as a
      // resolver-backed field on the TC. graphql-compose only invokes
      // the resolve fn when the client asks for the field, which
      // gives us lazy resolution for free; the `projection` hint
      // forces the parent finder to fetch the underlying scalar
      // fields the computed depends on.
      const computeds = computedFieldsOf(s);
      if (computeds.length) {
        const projection = {};
        for (const ff of s.fields || []) {
          if (!isComputedField(ff) && ff.type !== 'File') {
            projection[ff.name] = true;
          }
        }
        for (const f of computeds) {
          tc.addFields({
            [f.name]: wrapComputedField({
              type: computedGraphqlType(f.type),
              description: f.description,
              projection,
              field: f,
              compute: f.computed,
              // The wrapper hands us the per-call user; we hand it
              // back as the computed-context (with cross-resource
              // helpers) the schema-declared `computed(record, ctx)`
              // function expects.
              buildContext: ({ user }) =>
                buildComputedContext({
                  user,
                  getResource: (p) => getResource(p, s.version),
                }),
              log: logger,
            }),
          });
        }
      }
      tcByPath.set(s.path, { tc, schema: s, model });
    }

    for (const entry of registry.values()) {
      const { schema: s, model } = entry;
      const { tc } = tcByPath.get(s.path);
      const wrapById = wrapByIdMutation(model);
      const hasSearchable = (s.fields || []).some((f) => f && f.searchable);
      const r = (name) => {
        const resolver = tc.getResolver(name);
        // Schemas with searchable fields get a `search: String` arg
        // on every read resolver. wrapFilter peels it off and folds
        // it into a $text predicate on the filter.
        if (
          hasSearchable &&
          ['findOne', 'findMany', 'count', 'connection', 'pagination'].includes(name)
        ) {
          resolver.addArgs({ search: 'String' });
        }
        return resolver;
      };

      const p = s.path;
      // Reads honor schema.acl.list (admin/HR-style "see everything").
      queryFields[p + 'ById'] = wrapFindById(r('findById'), { schema: s });
      queryFields[p + 'ByIds'] = wrapFindByIds(r('findByIds'), { schema: s });
      queryFields[p + 'One'] = wrapFilter(r('findOne'), { schema: s, kind: 'read' });
      queryFields[p + 'Many'] = wrapFilter(r('findMany'), { schema: s, kind: 'read' });
      queryFields[p + 'Count'] = wrapFilter(r('count'), { schema: s, kind: 'read' });
      queryFields[p + 'Connection'] = wrapFilter(r('connection'), { schema: s, kind: 'read' });
      queryFields[p + 'Pagination'] = wrapFilter(r('pagination'), { schema: s, kind: 'read' });

      // Writes pass field-level ACL (`action: 'create' | 'update'`) so
      // the ACL'd fields a caller can't set are stripped from the
      // record before insert/update.
      mutationFields[p + 'CreateOne'] = wrapCreateOne(r('createOne'), { schema: s });
      mutationFields[p + 'CreateMany'] = wrapCreateMany(r('createMany'), { schema: s });
      mutationFields[p + 'UpdateById'] = wrapById(r('updateById'), { schema: s, action: 'update' });
      mutationFields[p + 'UpdateOne'] = wrapFilter(r('updateOne'), { schema: s, action: 'update' });
      mutationFields[p + 'UpdateMany'] = wrapFilter(r('updateMany'), { schema: s, action: 'update' });
      // Deletes honor schema.acl.delete.
      mutationFields[p + 'RemoveById'] = wrapById(r('removeById'), { schema: s, kind: 'delete' });
      mutationFields[p + 'RemoveMany'] = wrapFilter(r('removeMany'), { schema: s, kind: 'delete' });

      // Per-relation graph edges. We skip `field.reference` shorthand
      // here because the relation name collides with the existing
      // scalar field on the type (REST tolerates the collision; the
      // GraphQL type system doesn't). Tenant isolation rides on the
      // same wrapped resolvers used at the top level — wrapFilter /
      // wrapFindById both inject `userId` into the related query
      // before it hits Mongo.
      const normalized = normalizeRelations(s);
      for (const [relName, def] of Object.entries(normalized)) {
        if (def.fromShorthand) continue;
        const target = tcByPath.get(def.target);
        if (!target) continue;
        const targetTc = target.tc;
        const targetSchema = target.schema;

        if (def.kind === 'belongsTo') {
          const targetResolver = wrapFindById(
            targetTc.getResolver('findById'),
            { schema: targetSchema }
          );
          tc.addRelation(relName, {
            resolver: () => targetResolver,
            prepareArgs: { _id: (source) => source[def.localKey] },
            projection: { [def.localKey]: true },
          });
        } else if (def.kind === 'hasMany' && def.foreignKey) {
          const targetResolver = wrapFilter(
            targetTc.getResolver('findMany'),
            { schema: targetSchema, kind: 'read' }
          );
          tc.addRelation(relName, {
            resolver: () => targetResolver,
            prepareArgs: {
              filter: (source) => ({
                [def.foreignKey]: String(source._id),
                ...(def.where || {}),
              }),
            },
            projection: { _id: true },
          });
        } else if (def.kind === 'hasOne' && def.foreignKey) {
          const targetResolver = wrapFilter(
            targetTc.getResolver('findOne'),
            { schema: targetSchema, kind: 'read' }
          );
          tc.addRelation(relName, {
            resolver: () => targetResolver,
            prepareArgs: {
              filter: (source) => ({
                [def.foreignKey]: String(source._id),
                ...(def.where || {}),
              }),
            },
            projection: { _id: true },
          });
        }
      }

      // Per state-machine field: a top-level mutation
      // `<path>Transition<FieldName>(_id, to)` that runs the same
      // validate / persist / audit / event / onEnter pipeline as
      // the REST PUT path. The `to` arg is constrained to the
      // declared states via a generated GraphQL enum so a typo on
      // the wire is caught at validation time before any code
      // runs.
      for (const f of stateMachineFieldsOf(s)) {
        const PascalName = f.name.charAt(0).toUpperCase() + f.name.slice(1);
        const enumName = `${PascalName}State_${p}`;
        // GraphQL enum value NAMES must be valid GraphQL identifiers
        // ([_A-Za-z][_0-9A-Za-z]*). State strings are
        // user-controlled schema vocabulary, so a kebab-case
        // ('in-progress') or whitespace-bearing state would crash
        // composer.createEnumTC and take the whole rebuild down.
        // Sanitise the NAME but preserve the original string as the
        // value so wire/storage semantics are unchanged.
        const enumValues = {};
        const seenNames = new Map();
        for (const st of f.stateMachine.states) {
          let safe = String(st).replace(/[^_A-Za-z0-9]/g, '_');
          if (!/^[_A-Za-z]/.test(safe)) safe = `_${safe}`;
          // Disambiguate post-sanitisation collisions
          // (e.g. `in-progress` and `in_progress` both map to
          // `in_progress`).
          if (seenNames.has(safe)) {
            const n = seenNames.get(safe) + 1;
            seenNames.set(safe, n);
            safe = `${safe}_${n}`;
          } else {
            seenNames.set(safe, 1);
          }
          enumValues[safe] = { value: st };
        }
        if (!composer.has(enumName)) {
          composer.createEnumTC({ name: enumName, values: enumValues });
        }
        mutationFields[`${p}Transition${PascalName}`] = wrapStateTransition({
          type: tc,
          description: `Transition ${p}.${f.name} to a new state.`,
          args: { _id: 'MongoID!', to: `${enumName}!` },
          Model: model,
          schema: s,
          kind: 'write',
          action: 'update',
          runner: async ({ user, before, to }) => {
            const v = validateTransition(f, before[f.name], to);
            if (!v.valid) {
              // Apollo Server wraps unknown thrown errors as
              // INTERNAL_SERVER_ERROR. ApolloError(message, code,
              // properties) (our GraphQLError shim in
              // utils/graphqlErrors.js) puts the literal code on
              // `extensions.code` and spreads `properties` onto
              // `extensions`, so the typed code + structured details
              // survive to the wire exactly as they did under v3.
              throw new ApolloError(v.message, 'INVALID_TRANSITION', {
                details: {
                  field: f.name,
                  current: v.current,
                  attempted: v.attempted,
                  allowed: v.allowed,
                  reason: v.reason,
                },
              });
            }
            if (!v.transition) return before; // no-op: same state
            await model.updateOne(
              { _id: before._id, userId: user.user_id },
              { $set: { [f.name]: to } }
            );
            const after = await model.findById(before._id).lean();
            const auditOn = s.audit !== false;
            if (auditOn) {
              try {
                await recordAudit({
                  req: { user },
                  resource: s.path,
                  recordId: before._id,
                  action: 'transition',
                  before: { ...before, [f.name]: v.current },
                  after,
                });
              } catch (_) { /* best-effort */ }
            }
            emitRecordEvent({
              type: `${p}.transitioned`,
              version: s.version,
              userId: user.user_id,
              recordId: String(before._id),
              field: f.name,
              from: v.current,
              to,
            });
            // Also emit the standard updated event so existing
            // webhook subscribers see the change.
            emitRecordEvent({
              type: `${p}.updated`,
              version: s.version,
              userId: user.user_id,
              recordId: String(before._id),
            });
            const hook = (f.stateMachine.onEnter || {})[to];
            if (typeof hook === 'function') {
              try {
                await hook(after, { user, from: v.current, to });
              } catch (err) {
                logger.warn(
                  { err, field: f.name, to },
                  'state-machine onEnter hook threw; transition committed anyway'
                );
              }
            }
            return after;
          },
        });
      }

      // Per-aggregation top-level GraphQL queries. Query name is
      // `${path}${PascalCase(name)}`, return type is `[AggregationJSON]`.
      // Auth + tenant isolation are enforced through wrapAggregation
      // (defined in utils/scopeResolver.js) so this resolver follows
      // the same wrapping convention every other tenant-scoped GraphQL
      // resolver does.
      for (const agg of (s.aggregations || [])) {
        if (!agg || typeof agg.name !== 'string' || !Array.isArray(agg.pipeline)) {
          continue;
        }
        const queryName =
          p + agg.name.charAt(0).toUpperCase() + agg.name.slice(1);
        const args = {};
        for (const [paramName, def] of Object.entries(agg.params || {})) {
          // Map declared aggregation param types to GraphQL scalars.
          // dates and objectIds travel as strings on the wire and are
          // cast by validateAndCastParams inside runAggregation, so
          // there's exactly one place that knows how to parse them.
          const t =
            def.type === 'number'
              ? 'Float'
              : def.type === 'boolean'
              ? 'Boolean'
              : 'String';
          args[paramName] = def.required ? `${t}!` : t;
        }
        const aggSchema = s;
        const aggModel = model;
        const aggDef = agg;
        queryFields[queryName] = wrapAggregation({
          type: '[AggregationJSON]',
          args,
          description: agg.description || `Aggregation ${agg.name} on ${s.path}`,
          runner: async ({ user, params }) => {
            const result = await runAggregation({
              agg: aggDef,
              schema: aggSchema,
              model: aggModel,
              user,
              rawParams: params,
            });
            return result.data;
          },
        });
      }
    }
    // Suppress unused-variable warning on jsonScalar — it's referenced
    // implicitly by the `'[AggregationJSON]'` string type used above.
    void jsonScalar;

    composer.Query.addFields(queryFields);
    composer.Mutation.addFields(mutationFields);

    const newServer = new ApolloServer({
      schema: composer.buildSchema(),
      // Apollo Server v4 dropped the `playground` / `tracing` / `cors`
      // / `path` / `context` constructor options and v5 keeps them gone.
      // `introspection` is still gated the same way (and, with
      // introspection on, v5 serves the embedded Apollo Sandbox — the
      // successor to v3's GraphQL Playground — from its default
      // landing-page plugin). `cors` and body parsing are handled by the
      // parent Express stack (helmet / buildCorsMiddleware /
      // express.json) mounted ahead of the indirection middleware in
      // app.js, so the integration doesn't re-apply them here.
      // csrfPrevention stays on (it's also the v4+ default) to keep the
      // GHSA-9q82-xgwf-vj6h XS-Search vector closed.
      introspection: !isProduction(),
      csrfPrevention: true,
    });
    // v4+ requires an explicit start() before the request handler can be
    // mounted. The loader's single-flight queue already serialises
    // rebuilds, so awaiting here can't interleave with another rebuild.
    await newServer.start();

    // Context moves from the server constructor (v3) onto the Express
    // integration (v4+). `buildGraphqlContext` keeps its `({ req }) =>
    // { user }` shape, so scopeResolver's `ctx.user` reads unchanged.
    const newRouter = express.Router();
    newRouter.use(
      '/graphql/',
      expressMiddleware(newServer, { context: buildGraphqlContext })
    );

    // Swap the indirection BEFORE stopping the old server. If we stopped
    // first, in-flight or new requests during the rebuild window would
    // hit a dead router. Now the parent app routes new requests to the
    // fresh server immediately, and we shut the old one down to release
    // its plugins / sockets / timers.
    const oldServer = currentApolloServer;
    currentApolloServer = newServer;
    setApolloRouter(newRouter);

    if (oldServer) {
      try {
        await oldServer.stop();
      } catch (err) {
        logger.warn({ err }, 'failed to stop previous ApolloServer; continuing');
      }
    }
  }

  /**
   * Splice a registered Express Router out of the parent app's
   * middleware stack. We mounted the router via `app.use(router)` so it
   * appears as a Layer in `app._router.stack`; pulling it by reference
   * is the cleanest way to remove it without rebuilding the whole stack.
   */
  function spliceRouter(router) {
    const stack = app._router && app._router.stack;
    if (!stack) return;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].handle === router) stack.splice(i, 1);
    }
  }

  async function loadSchemaImpl(s, { deferGraphqlRebuild = false } = {}) {
    // Guard against an empty or half-written schema module (e.g. an
    // editor that creates `workout.js` empty before you type into it,
    // which exports `{}`). Without this the artifact builder below
    // dereferences `s.fields.forEach` and throws a cryptic
    // "Cannot read properties of undefined (reading 'forEach')";
    // a typed ValidationError names the actual problem instead.
    if (!s || typeof s !== 'object' || typeof s.path !== 'string' || !Array.isArray(s.fields)) {
      throw new ValidationError(
        'invalid schema: expected a module exporting an object with a string `path` and a `fields` array' +
          (s && s.path ? ` (path="${s.path}")` : '')
      );
    }
    const key = `${s.version}/${s.path}`;
    if (registry.has(key)) {
      // Already loaded — caller probably meant reload.
      await unloadSchemaImpl(key, { skipGraphqlRebuild: true });
    }

    const {
      mongooseSchema,
      references,
      fileFields,
      searchableFields,
      softDeleteEnabled,
      auditEnabled,
    } = buildSchemaArtifacts(s);

    // mongoose throws if a model with the same name is already registered;
    // belt-and-suspenders cleanup in case unload missed it.
    if (mongoose.models[s.collection]) {
      mongoose.deleteModel(s.collection);
    }
    const model = mongoose.model(s.collection, mongooseSchema);

    // Ensure the model's indexes (including any text index from
    // searchable: true fields) are actually built before requests
    // fly. Mongoose schedules autoIndex async, and routes that use
    // $text immediately after load would otherwise race the index
    // creation. Errors are non-fatal — log and proceed so a single
    // bad index doesn't block the whole load.
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        await model.init();
      } catch (err) {
        logger.warn({ err, schema: key }, 'index creation failed; continuing without indexes');
      }
    }

    const swaggerKeys = buildSwagger(s, model);
    const router = buildRestRouter(
      s,
      model,
      references,
      mongooseSchema,
      fileFields,
      searchableFields,
      { softDeleteEnabled, auditEnabled }
    );
    app.use(router);
    moveErrorHandlerToEnd();

    registry.set(key, { schema: s, model, router, swaggerKeys });

    if (!deferGraphqlRebuild) {
      await rebuildGraphQL();
    }
    logger.info({ schema: key }, 'schema loaded');
    notifyChange();
    return key;
  }

  async function unloadSchemaImpl(key, { skipGraphqlRebuild = false } = {}) {
    const entry = registry.get(key);
    if (!entry) return false;
    registry.delete(key);

    spliceRouter(entry.router);
    moveErrorHandlerToEnd();

    delete apiSpec.paths[entry.swaggerKeys.collectionPath];
    delete apiSpec.paths[entry.swaggerKeys.itemPath];
    for (const p of entry.swaggerKeys.fileSwaggerPaths || []) {
      delete apiSpec.paths[p];
    }
    for (const p of entry.swaggerKeys.aggregationSwaggerPaths || []) {
      delete apiSpec.paths[p];
    }
    delete apiSpec.definitions[entry.schema.path];

    if (mongoose.models[entry.schema.collection]) {
      mongoose.deleteModel(entry.schema.collection);
    }

    if (!skipGraphqlRebuild) {
      await rebuildGraphQL();
    }
    logger.info({ schema: key }, 'schema unloaded');
    notifyChange();
    return true;
  }

  // Public API: every entry point goes through the single-flight queue
  // so the order of events from the watcher (or concurrent programmatic
  // calls) is preserved and rebuildGraphQL always sees a consistent
  // registry snapshot.
  const loadSchema = (s, opts) => enqueue(() => loadSchemaImpl(s, opts));
  const unloadSchema = (key, opts) => enqueue(() => unloadSchemaImpl(key, opts));
  const rebuildGraphQLQueued = () => enqueue(() => rebuildGraphQL());

  function listSchemas() {
    return Array.from(registry.keys());
  }

  function getEntry(key) {
    return registry.get(key) || null;
  }

  /**
   * Subscribe to registry change notifications. Returns an
   * unsubscribe function. Used by the long-lived stdio MCP server to
   * refresh its tool list whenever a schema is loaded or unloaded.
   */
  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  }

  return {
    loadSchema,
    unloadSchema,
    listSchemas,
    getEntry,
    onChange,
    rebuildGraphQL: rebuildGraphQLQueued,
    // Expose runAggregation so adjacent surfaces (MCP server, custom
    // routes added after the schemas.forEach loop) can call into the
    // same safety/cache/tenant code path that REST and GraphQL use.
    runAggregation,
    // Exposed for the plugin loader: after plugins register their
    // routes via `app.use`, errorHandler needs to be re-asserted at
    // the tail of the middleware stack, the same invariant the
    // schema loader maintains on every load/unload.
    moveErrorHandlerToEnd,
  };
}

module.exports = { createSchemaLoader };
