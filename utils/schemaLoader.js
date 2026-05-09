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
const { NotFoundError } = require('./errors');
const {
  wrapFilter,
  wrapCreateOne,
  wrapCreateMany,
  wrapFindById,
  wrapFindByIds,
  wrapByIdMutation,
} = require('./scopeResolver');

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
function createSchemaLoader({ app, apiSpec, setApolloRouter, buildGraphqlContext, isProduction }) {
  // key = `${version}/${path}`
  const registry = new Map();

  function buildSchemaArtifacts(s) {
    const fields = {};
    const unique = [];
    const references = [];
    s.fields.forEach((f) => {
      fields[f.name] = f;
      if (f.unique) unique.push(f.name);
      if (f.reference) references.push(f.reference);
    });

    const mongooseSchema = new mongoose.Schema(fields);
    mongooseSchema.plugin(timestamps);
    mongooseSchema.index({ createdAt: 1 });
    mongooseSchema.index({ updatedAt: 1 });
    if (s.compositeIndex) {
      s.compositeIndex.forEach((i) => mongooseSchema.index(i, { unique: true }));
    }

    return { mongooseSchema, unique, references };
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
        parameters: Object.keys(swaggerSchema.properties).map((sc) => ({
          name: sc,
          in: 'query',
          type: 'string',
          description: 'mongo-querystring formatted query parameters',
        })),
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
    apiSpec.paths[itemPath] = {
      get: {
        tags: [tag],
        parameters: [{ in: 'path', name: 'id', type: 'string', required: true }],
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

    return { collectionPath, itemPath, schemaPath: `${collectionPath}-schema` };
  }

  function buildRestRouter(s, model, references, mongooseSchema) {
    const router = express.Router();
    const path = s.path;
    const PAGE_SIZE = process.env.PAGE_SIZE;

    router.get(`/api/${s.version}/${path}-schema`, async (req, res) => {
      const jsSchema = mongooseSchema.jsonSchema();
      ['_id', 'createdAt', 'updatedAt', '__v'].forEach((k) => {
        delete jsSchema.properties[k];
      });
      res.status(200).send(jsSchema);
    });

    router.post(
      `/api/${s.version}/${path}`,
      auth(true),
      asyncHandler(async (req, res) => {
        const data = {
          ...req.body,
          accountId: req.user.user_id,
          userId: req.user.user_id,
        };
        const record = await model.create(data);
        res.status(201).json(record);
      })
    );

    router.get(
      `/api/${s.version}/${path}`,
      auth(true),
      asyncHandler(async (req, res) => {
        const pageSize = parseInt(PAGE_SIZE);
        const page = parseInt(req.query.__page) || 1;
        const sort = req.query.__sort || false;
        const sortObject = {};
        if (sort) {
          const vals = sort.split(':');
          sortObject[vals[0]] = vals[1];
        }
        const querystring = { ...req.query };
        Object.keys(req.query).forEach((q) => {
          if (q.startsWith('__')) delete querystring[q];
        });
        const query = qs.parse(querystring);
        query['userId'] = req.user.user_id;

        const [list, count] = await Promise.all([
          model
            .find(query)
            .sort(sortObject)
            .skip((page - 1) * pageSize)
            .limit(pageSize),
          model.find(query).countDocuments(),
        ]);

        const totalPages = Math.ceil(count / pageSize);
        const result = {
          results: list,
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
        const query = qs.parse(req.query);
        query['userId'] = req.user.user_id;
        const record = await model.updateMany(
          query,
          { $set: req.body },
          { upsert: true }
        );
        res.status(200).json(record);
      })
    );

    router.get(
      `/api/${s.version}/${path}/:id`,
      auth(true),
      asyncHandler(async (req, res) => {
        const query = { userId: req.user.user_id, _id: req.params.id };
        const record = await model.findOne(query);
        if (!record) throw new NotFoundError(path);

        const copy = JSON.parse(JSON.stringify(record));
        for (const r of references) {
          if (!copy[r]) continue;
          const refModel = mongoose.models[r];
          if (!refModel) continue;
          const ref = await refModel.findById(copy[r]).lean().exec();
          if (ref) copy[r] = ref;
        }
        res.status(200).json(copy);
      })
    );

    router.delete(
      `/api/${s.version}/${path}/:id`,
      auth(true),
      asyncHandler(async (req, res) => {
        const query = { userId: req.user.user_id, _id: req.params.id };
        const result = await model.deleteOne(query);
        if (!result.deletedCount) throw new NotFoundError(path);
        res.status(200).json(result);
      })
    );

    router.put(
      `/api/${s.version}/${path}/:id`,
      auth(true),
      asyncHandler(async (req, res) => {
        const query = { userId: req.user.user_id, _id: req.params.id };
        const result = await model.updateOne(query, { $set: req.body });
        if (!result.matchedCount) throw new NotFoundError(path);
        res.status(200).json(result);
      })
    );

    return router;
  }

  /**
   * Rebuild the GraphQL schema from scratch (across all registered
   * schemas) and swap Apollo's middleware. Done end-to-end on every
   * load/unload because graphql-compose's type registry is global —
   * keeping the registry consistent on partial unload would require
   * tracking every type composeWithMongoose creates per schema and
   * deleting them individually.
   */
  async function rebuildGraphQL() {
    const composer = new mongoSc.SchemaComposer();
    const queryFields = {};
    const mutationFields = {};

    for (const entry of registry.values()) {
      const { schema: s, model } = entry;
      const tc = mongoGql.composeWithMongoose(model, { schemaComposer: composer });
      const wrapById = wrapByIdMutation(model);
      const r = (name) => tc.getResolver(name);

      const p = s.path;
      queryFields[p + 'ById'] = wrapFindById(r('findById'));
      queryFields[p + 'ByIds'] = wrapFindByIds(r('findByIds'));
      queryFields[p + 'One'] = wrapFilter(r('findOne'));
      queryFields[p + 'Many'] = wrapFilter(r('findMany'));
      queryFields[p + 'Count'] = wrapFilter(r('count'));
      queryFields[p + 'Connection'] = wrapFilter(r('connection'));
      queryFields[p + 'Pagination'] = wrapFilter(r('pagination'));

      mutationFields[p + 'CreateOne'] = wrapCreateOne(r('createOne'));
      mutationFields[p + 'CreateMany'] = wrapCreateMany(r('createMany'));
      mutationFields[p + 'UpdateById'] = wrapById(r('updateById'));
      mutationFields[p + 'UpdateOne'] = wrapFilter(r('updateOne'));
      mutationFields[p + 'UpdateMany'] = wrapFilter(r('updateMany'));
      mutationFields[p + 'RemoveById'] = wrapById(r('removeById'));
      mutationFields[p + 'RemoveMany'] = wrapFilter(r('removeMany'));
    }

    composer.Query.addFields(queryFields);
    composer.Mutation.addFields(mutationFields);

    const server = new apollo.ApolloServer({
      schema: composer.buildSchema(),
      cors: true,
      playground: !isProduction(),
      introspection: !isProduction(),
      tracing: true,
      path: '/',
      context: buildGraphqlContext,
    });
    await server.start();

    const router = express.Router();
    server.applyMiddleware({
      app: router,
      path: '/graphql/',
      cors: true,
      onHealthCheck: () =>
        new Promise((resolve, reject) => {
          if (mongoose.connection.readyState > 0) resolve();
          else reject();
        }),
    });

    setApolloRouter(router);
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

  async function loadSchema(s, { deferGraphqlRebuild = false } = {}) {
    const key = `${s.version}/${s.path}`;
    if (registry.has(key)) {
      // Already loaded — caller probably meant reload.
      await unloadSchema(key, { skipGraphqlRebuild: true });
    }

    const { mongooseSchema, references } = buildSchemaArtifacts(s);

    // mongoose throws if a model with the same name is already registered;
    // belt-and-suspenders cleanup in case unload missed it.
    if (mongoose.models[s.collection]) {
      mongoose.deleteModel(s.collection);
    }
    const model = mongoose.model(s.collection, mongooseSchema);

    const swaggerKeys = buildSwagger(s, model);
    const router = buildRestRouter(s, model, references, mongooseSchema);
    app.use(router);

    registry.set(key, { schema: s, model, router, swaggerKeys });

    if (!deferGraphqlRebuild) {
      await rebuildGraphQL();
    }
    logger.info({ schema: key }, 'schema loaded');
    return key;
  }

  async function unloadSchema(key, { skipGraphqlRebuild = false } = {}) {
    const entry = registry.get(key);
    if (!entry) return false;
    registry.delete(key);

    spliceRouter(entry.router);

    delete apiSpec.paths[entry.swaggerKeys.collectionPath];
    delete apiSpec.paths[entry.swaggerKeys.itemPath];
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

  function listSchemas() {
    return Array.from(registry.keys());
  }

  return { loadSchema, unloadSchema, listSchemas, rebuildGraphQL };
}

module.exports = { createSchemaLoader };
