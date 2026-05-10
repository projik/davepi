const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const timestamps = require('mongoose-timestamp');
const m2s = require('mongoose-to-swagger');
const mongoGql = require('graphql-compose-mongoose');
const mongoSc = require('graphql-compose');
const apollo = require('apollo-server-express');
const MongoQS = require('mongo-querystring');

const auth = require('../middleware/auth');
const asyncHandler = require('./asyncHandler');
const logger = require('./logger');
const { NotFoundError, ValidationError } = require('./errors');
const { emitRecordEvent } = require('./events');
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
const {
  normalizeRelations,
  parseIncludes,
  applyIncludes,
} = require('./relations');
const {
  projectByAcl,
  projectListByAcl,
  filterWritable,
  bypassUserScopeForList,
  bypassUserScopeForDelete,
} = require('./acl');
const {
  wrapFilter,
  wrapCreateOne,
  wrapCreateMany,
  wrapFindById,
  wrapFindByIds,
  wrapByIdMutation,
  wrapAggregation,
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
 * ApolloServer, applyMiddleware's it onto a brand-new express.Router,
 * and calls the supplied `setApolloRouter` so the indirection middleware
 * mounted in app.js routes new requests through it.
 */
function createSchemaLoader({ app, apiSpec, setApolloRouter, buildGraphqlContext, isProduction, errorHandler }) {
  // key = `${version}/${path}`
  const registry = new Map();

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
          ...Object.keys(swaggerSchema.properties).map((sc) => ({
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
        auth(true),
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
        auth(true),
        asyncHandler(async (req, res) => {
          const baseOwner = bypassUserScopeForList(s, req.user)
            ? { _id: req.params.id }
            : { _id: req.params.id, userId: req.user.user_id };
          const ownerQuery = softDeleteEnabled ? { ...baseOwner, deletedAt: null } : baseOwner;
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
        auth(true),
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
      auth(true),
      asyncHandler(async (req, res) => {
        const jsSchema = mongooseSchema.jsonSchema();
        ['_id', 'createdAt', 'updatedAt', '__v'].forEach((k) => {
          delete jsSchema.properties[k];
        });
        res.status(200).send(jsSchema);
      })
    );

    router.post(
      `/api/${s.version}/${path}`,
      auth(true),
      asyncHandler(async (req, res) => {
        const writable = filterWritable(req.body, s, req.user, 'create');
        const data = {
          ...writable,
          accountId: req.user.user_id,
          userId: req.user.user_id,
        };
        const record = await model.create(data);
        const plain = JSON.parse(JSON.stringify(record));
        await decorateFileUrls(plain, s, storage);
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
        });
        res.status(201).json(projected);
      })
    );

    router.get(
      `/api/${s.version}/${path}`,
      auth(true),
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
      auth(true),
      asyncHandler(async (req, res) => {
        // The query predicate doubles as the create-time payload on
        // upsert (Mongo seeds new docs with the predicate's equality
        // keys). Filter the client-provided keys through
        // filterWritable('create') first so ACL-create-restricted
        // fields can't be smuggled in via the query string, THEN stamp
        // userId so tenant isolation is non-bypassable.
        const rawQuery = qs.parse(req.query);
        const filteredQuery = filterWritable(rawQuery, s, req.user, 'create');
        const safeQuery = {
          ...filteredQuery,
          userId: req.user.user_id,
          // Bulk PUT must NOT touch tombstones — soft-deleted records
          // are read-only at the API layer until restored. Without
          // this constraint, an unsuspecting `?accountName=X` could
          // resurrect (or upsert via) a tombstoned doc.
          ...(softDeleteEnabled ? { deletedAt: null } : {}),
        };
        const writable = filterWritable(req.body, s, req.user, 'update');
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
        });
        res.status(200).json(record);
      })
    );

    router.get(
      `/api/${s.version}/${path}/:id`,
      auth(true),
      asyncHandler(async (req, res) => {
        const baseQuery = bypassUserScopeForList(s, req.user)
          ? { _id: req.params.id }
          : { userId: req.user.user_id, _id: req.params.id };
        const query = applySoftDeleteFilter(baseQuery, req);
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

        res.status(200).json(projectByAcl(copy, s, req.user));
      })
    );

    router.delete(
      `/api/${s.version}/${path}/:id`,
      auth(true),
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
          const now = new Date();
          await model.updateOne(
            { _id: existing._id },
            { $set: { deletedAt: now } }
          );
          await audit({
            req,
            recordId: existing._id,
            action: 'delete',
            before: existing,
            after: { ...existing, deletedAt: now },
          });
          emitRecordEvent({
            type: `${path}.deleted`,
            version: s.version,
            userId: req.user.user_id,
            recordId: String(req.params.id),
          });
          return res.status(200).json({ acknowledged: true, deletedCount: 1, softDeleted: true });
        }

        // Hard-delete path (schemas with softDelete: false).
        const existing = (fileFields && fileFields.length)
          ? await model.findOne(baseQuery).lean()
          : await model.findOne(baseQuery).lean();
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
        });
        res.status(200).json(result);
      })
    );

    if (softDeleteEnabled) {
      router.post(
        `/api/${s.version}/${path}/:id/restore`,
        auth(true),
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
      auth(true),
      asyncHandler(async (req, res) => {
        const pageSize = parseInt(PAGE_SIZE);
        const page = parseInt(req.query.__page) || 1;
        // Authorization: must be able to read the record (deleted or
        // not). Bypass for acl.list roles, otherwise the caller must
        // own the record.
        const ownerQuery = bypassUserScopeForList(s, req.user)
          ? { _id: req.params.id }
          : { _id: req.params.id, userId: req.user.user_id };
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
      auth(true),
      asyncHandler(async (req, res) => {
        // Updates stay strictly owner-bound. acl.list grants read
        // visibility; the spec doesn't define a write-bypass slot, so
        // only the record's owner may PUT regardless of role.
        const query = applySoftDeleteFilter(
          { userId: req.user.user_id, _id: req.params.id },
          req
        );
        const writable = filterWritable(req.body, s, req.user, 'update');
        const before = auditEnabled
          ? await model.findOne(query).lean()
          : null;
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
        if (auditEnabled && before) {
          const after = await model.findById(req.params.id).lean();
          await audit({
            req,
            recordId: req.params.id,
            action: 'update',
            before,
            after,
          });
        }
        emitRecordEvent({
          type: `${path}.updated`,
          version: s.version,
          userId: req.user.user_id,
          recordId: String(req.params.id),
        });
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
        auth(true),
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

    const newServer = new apollo.ApolloServer({
      schema: composer.buildSchema(),
      cors: true,
      playground: !isProduction(),
      introspection: !isProduction(),
      tracing: true,
      path: '/',
      context: buildGraphqlContext,
    });
    await newServer.start();

    const newRouter = express.Router();
    newServer.applyMiddleware({
      app: newRouter,
      path: '/graphql/',
      cors: true,
      onHealthCheck: () =>
        new Promise((resolve, reject) => {
          if (mongoose.connection.readyState > 0) resolve();
          else reject();
        }),
    });

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

  return {
    loadSchema,
    unloadSchema,
    listSchemas,
    getEntry,
    rebuildGraphQL: rebuildGraphQLQueued,
    // Expose runAggregation so adjacent surfaces (MCP server, custom
    // routes added after the schemas.forEach loop) can call into the
    // same safety/cache/tenant code path that REST and GraphQL use.
    runAggregation,
  };
}

module.exports = { createSchemaLoader };
