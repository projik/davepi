// Importing this module is a pure operation: it builds the Express app,
// the Mongoose models, the GraphQL schema, and the Swagger spec, but
// does NOT load .env or connect to MongoDB. The caller (index.js or a
// test harness) is responsible for both. This makes app.js safe to
// require from tests with an in-memory Mongo URI already set.
const express = require("express");
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const timestamps = require('mongoose-timestamp');
const MongoQS = require('mongo-querystring');
const m2s = require('mongoose-to-swagger');
const swaggerUI = require("swagger-ui-express");
const mongoGql = require('graphql-compose-mongoose');
const mongoSc = require('graphql-compose');
const apollo = require('apollo-server-express');
const async = require('async');
const _ = require('lodash');
const app = express();
const dirTree = require("directory-tree");

const auth = require("./middleware/auth");
const errorHandler = require("./middleware/errorHandler");
const httpLogger = require("./middleware/httpLogger");
const { buildCorsMiddleware } = require("./middleware/corsConfig");
const { authLimiter, apiLimiter } = require("./middleware/rateLimit");
const asyncHandler = require("./utils/asyncHandler");
const logger = require("./utils/logger");
const {
  NotFoundError,
  ValidationError,
  ConflictError,
} = require("./utils/errors");
const {
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
} = require("./utils/tokens");
const { sendMail } = require("./utils/mailer");
const PasswordResetToken = require("./model/passwordResetToken");
const RefreshToken = require("./model/refreshToken");
const crypto = require("crypto");
const {
  wrapFilter,
  wrapCreateOne,
  wrapCreateMany,
  wrapFindById,
  wrapFindByIds,
  wrapByIdMutation,
} = require("./utils/scopeResolver");

const { PAGE_SIZE, API_PORT } = process.env;
const port = process.env.PORT || API_PORT;
const appName = process.env.APP_NAME || "dAvePi"

require('mongoose-schema-jsonschema')(mongoose);

const schemaComposer = new mongoSc.SchemaComposer();

// Default helmet (CSP enabled) for all routes. Swagger UI and Apollo's
// GraphQL Playground need inline scripts / remote bundles, so CSP and
// crossOriginEmbedderPolicy are dropped only for those paths.
const helmetDefault = helmet();
const helmetForBrowserTooling = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api-docs') || req.path.startsWith('/graphql')) {
    return helmetForBrowserTooling(req, res, next);
  }
  return helmetDefault(req, res, next);
});
app.use(buildCorsMiddleware());
app.use(express.json());
app.use(httpLogger);
app.use('/api', apiLimiter);

const qs = new MongoQS();

const filteredTree = dirTree("./schema/versions", { extensions: /\.js/ });
const schemas = [];
filteredTree.children.forEach((t) => {
  t.children.forEach((c) => {
    const schema = require("./" + c.path);
    schema.version = t.name;
    schemas.push(schema);
  })
})

const model = {};
const graph = {};
const schema = {};
const gQuery = {};
const gMutation = {};
const apiSpec = {
  "info": {
      "title": appName,
      "version": "1.0.0",
      "description": `${appName} REST API documentation.`
  },
  "host": `localhost:${port}`,
  "basePath": "/",
  "swagger": "2.0",
  "paths": {},
  "definitions": {}
  }

schemas.forEach((s) => {
  const fields = {};
  const unique = [];
  const references = [];
  const path = s.path;
  s.fields.forEach((f) => {
    fields[f.name] = f;
    // fields[f.name] = {
    //   type: f.type,
    //   default: f.default,
    //   unique: f.unique,
    //   index: (f.unique || f.index),
    //   required: f.required
    // }
    if (f.unique) unique.push(f.name);
    if (f.reference) references.push(f.reference);
  });
  schema[path] = new mongoose.Schema(fields);
  schema[path].plugin(timestamps);
  schema[path].index({ createdAt: 1 });
  schema[path].index({ updatedAt: 1 });
  if (s.compositeIndex) {
    s.compositeIndex.forEach((i) => {
      schema[path].index(i, { unique: true });
    });
  }
  model[path] = mongoose.model(s.collection, schema[path]);

  // GraphQL server
  graph[path] = mongoGql.composeWithMongoose(model[path]);

  
  const wrapById = wrapByIdMutation(model[path]);
  const r = (name) => graph[path].getResolver(name);

  gQuery[path] = {};
  gQuery[path][path + 'ById'] = wrapFindById(r('findById'));
  gQuery[path][path + 'ByIds'] = wrapFindByIds(r('findByIds'));
  gQuery[path][path + 'One'] = wrapFilter(r('findOne'));
  gQuery[path][path + 'Many'] = wrapFilter(r('findMany'));
  gQuery[path][path + 'Count'] = wrapFilter(r('count'));
  gQuery[path][path + 'Connection'] = wrapFilter(r('connection'));
  gQuery[path][path + 'Pagination'] = wrapFilter(r('pagination'));

  gMutation[path] = {};
  gMutation[path][path + 'CreateOne'] = wrapCreateOne(r('createOne'));
  gMutation[path][path + 'CreateMany'] = wrapCreateMany(r('createMany'));
  gMutation[path][path + 'UpdateById'] = wrapById(r('updateById'));
  gMutation[path][path + 'UpdateOne'] = wrapFilter(r('updateOne'));
  gMutation[path][path + 'UpdateMany'] = wrapFilter(r('updateMany'));
  gMutation[path][path + 'RemoveById'] = wrapById(r('removeById'));
  gMutation[path][path + 'RemoveMany'] = wrapFilter(r('removeMany'));

  schemaComposer.Query.addFields({
    ...gQuery[path]
  });

  schemaComposer.Mutation.addFields({
    ...gMutation[path]
  });

  // Swagger Schema generation
  const swaggerSchema = m2s(model[path]);
  const postSchema = m2s(model[path], { omitFields: ['_id', 'createdAt', 'updatedAt']});
  const putSchema = JSON.parse(JSON.stringify(postSchema));
  delete putSchema.required;
  swaggerSchema.type = 'object';
  apiSpec.definitions[path] = swaggerSchema;
  app.get(`/api/${s.version}/${path}-schema`, async (req, res) => {
    const jsSchema = schema[path].jsonSchema();
    ['_id', 'createdAt', 'updatedAt', '__v'].forEach((s) => {
      delete jsSchema.properties[s];
    })
    res.status(200).send(jsSchema);
  });

  const tag = path.charAt(0).toUpperCase() + path.slice(1);
  apiSpec.paths[`/api/${s.version}/${path}`] = {
    "post": {
      "tags": [tag],
      "consumes": ["application/json"],
      "produces": ["application/json"],
      "parameters": [{
        "in": "body",
        "name": "body",
        "required": true,
        "schema": postSchema
      }],
      "responses": {
        "201": {
          "description": "success",
          "schema": {
            "$ref": `#/definitions/${path}`
          }
        }
      }
    },
    "get": {
      "tags": [tag],
      "consumes": ["application/json"],
      "produces": ["application/json"],
      "parameters": Object.keys(swaggerSchema.properties).map((sc) => {
        return {
          "name": sc,
          "in": "query",
          "type": "string",
          "description": "mongo-querystring formatted query parameters"
        }
      }),
      "responses": {
        "200": {
          "description": "success",
          "schema": {
            "type": "array",
            "items": {
              "$ref": `#/definitions/${path}`
            }
          }
        }
      }
    },
    "put": {
      "tags": [tag],
      "consumes": ["application/json"],
      "produces": ["application/json"],
      "parameters": [{
        "in": "query",
        "name": `query`,
        "type": "string",
        "description": "mongo-querystring formatted query parameters"
      }, {
        "in": "body",
        "name": "body",
        "required": true,
        "schema": putSchema
      }],
      "responses": {
        "200": {
          "description": "success",
          "schema": {
            "$ref": `#/definitions/${path}`
          }
        }
      }
    }
  }

  app.post(`/api/${s.version}/${path}`, auth(true), asyncHandler(async (req, res) => {
    const data = {
      ...req.body,
      accountId: req.user.user_id,
      userId: req.user.user_id,
    };
    const record = await model[path].create(data);
    res.status(201).json(record);
  }));

  app.get(`/api/${s.version}/${path}`, auth(true), asyncHandler(async (req, res) => {
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
      model[path]
        .find(query)
        .sort(sortObject)
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      model[path].find(query).countDocuments(),
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
  }));

  app.put(`/api/${s.version}/${path}`, auth(true), asyncHandler(async (req, res) => {
    const query = qs.parse(req.query);
    query['userId'] = req.user.user_id;
    const record = await model[path].updateMany(
      query,
      { $set: req.body },
      { upsert: true }
    );
    res.status(200).json(record);
  }));

  apiSpec.paths[`/api/${s.version}/${path}/{id}`] = {
    "get": {
      "tags": [tag],
      "consumes": ["application/json"],
      "produces": ["application/json"],
      "parameters": [{
        "in": "path",
        "name": "id",
        "type": "string",
        "description": `Id of ${path}`,
        "required": true
      }],
      "responses": {
        "200": {
          "description": "success",
          "schema": {
            "$ref": `#/definitions/${path}`
          }
        }
      }
    },
    "delete": {
      "tags": [tag],
      "consumes": ["application/json"],
      "produces": ["application/json"],
      "parameters": [{
        "in": "path",
        "name": "id",
        "type": "string",
        "description": `Id of ${path}`,
        "required": true
      }],
      "responses": {
        "200": {
          "description": "success",
          "schema": {
            "$ref": `#/definitions/${path}`
          }
        }
      }
    },
    "put": {
      "tags": [tag],
      "consumes": ["application/json"],
      "produces": ["application/json"],
      "parameters": [{
        "in": "path",
        "name": "id",
        "type": "string",
        "description": `Id of ${path}`,
        "required": true
      }, {
        "in": "body",
        "name": "body",
        "schema": putSchema
      }],
      "responses": {
        "200": {
          "description": "success",
          "schema": {
            "$ref": `#/definitions/${path}`
          }
        }
      }
    }
  }
  app.get(`/api/${s.version}/${path}/:id`, auth(true), asyncHandler(async (req, res) => {
    const query = { userId: req.user.user_id, _id: req.params.id };
    const record = await model[path].findOne(query);
    if (!record) throw new NotFoundError(path);

    const copy = JSON.parse(JSON.stringify(record));
    for (const r of references) {
      if (!copy[r]) continue;
      const ref = await model[r].findById(copy[r]).lean().exec();
      if (ref) copy[r] = ref;
    }
    res.status(200).json(copy);
  }));

  app.delete(`/api/${s.version}/${path}/:id`, auth(true), asyncHandler(async (req, res) => {
    const query = { userId: req.user.user_id, _id: req.params.id };
    const result = await model[path].deleteOne(query);
    if (!result.deletedCount) throw new NotFoundError(path);
    res.status(200).json(result);
  }));

  app.put(`/api/${s.version}/${path}/:id`, auth(true), asyncHandler(async (req, res) => {
    const query = { userId: req.user.user_id, _id: req.params.id };
    const result = await model[path].updateOne(query, { $set: req.body });
    if (!result.matchedCount) throw new NotFoundError(path);
    res.status(200).json(result);
  }));

});

logger.info({ schemas: schemas.map((s) => `${s.version}/${s.path}`) }, 'schemas loaded');

const User = require("./model/user");

// Register
/**
 * Create a new user in our database and return the user with a token.
 * @param req - The request object.
 * @param res - The response object.
 * @returns A new user object with a token
 */
const buildUserResponse = (user) => {
  const obj = JSON.parse(JSON.stringify(user));
  delete obj.password;
  delete obj.__v;
  delete obj.token; // legacy field on the user model — never serialize it
  return obj;
};

app.post("/register", authLimiter, asyncHandler(async (req, res) => {
  const { first_name, last_name, email, password } = req.body;

  if (!(email && password && first_name && last_name)) {
    throw new ValidationError("All input is required");
  }

  const oldUser = await User.findOne({ email: email.toLowerCase() });
  if (oldUser) {
    throw new ConflictError("User Already Exists. Please Login");
  }

  const encryptedPassword = await bcrypt.hash(password, 10);

  const user = await User.create({
    first_name,
    last_name,
    email: email.toLowerCase(),
    password: encryptedPassword,
  });

  const tokens = await issueTokenPair(user, req);
  res.status(201).json({ ...tokens, user: buildUserResponse(user) });
}));

app.post("/login", authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!(email && password)) {
    throw new ValidationError("All input is required");
  }

  const user = await User.findOne(
    { email: email.toLowerCase() },
    { first_name: 1, last_name: 1, email: 1, password: 1 }
  );

  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new ValidationError("Invalid Credentials");
  }

  const tokens = await issueTokenPair(user, req);
  res.status(200).json({ ...tokens, user: buildUserResponse(user) });
}));

// Public on purpose: /auth/refresh is the path clients take when their
// access-token JWT has already expired, so requiring auth(true) here
// would make the endpoint useless. The refresh token in the body is the
// authentication — rotateRefreshToken hashes and looks it up against
// refresh_tokens, throws UnauthorizedError on miss/expired/reuse.
app.post("/auth/refresh", authLimiter, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    throw new ValidationError("refreshToken required");
  }
  const tokens = await rotateRefreshToken(refreshToken, req);
  res.status(200).json(tokens);
}));

// Public on purpose: a user whose access token has expired must still
// be able to log out (revoke their refresh token). The refresh token
// in the body identifies the session being terminated.
app.post("/auth/logout", asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  await revokeRefreshToken(refreshToken);
  res.status(204).end();
}));

const sha256 = (input) =>
  crypto.createHash("sha256").update(input).digest("hex");

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Public on purpose: this endpoint is the entry point to the recovery
// flow before the user has any credentials. Crucially it ALWAYS returns
// 204 — including when the email is unknown OR when token creation /
// email delivery fails internally — so it can't be used as a
// user-enumeration oracle. Internal errors are logged for operators.
app.post(
  "/auth/forgot-password",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (typeof email === "string" && email.length) {
      try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (user) {
          const rawToken = crypto.randomBytes(32).toString("hex");
          await PasswordResetToken.create({
            userId: user._id,
            tokenHash: sha256(rawToken),
            expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
          });
          const appUrl = process.env.APP_URL || "http://localhost:3000";
          const resetUrl = `${appUrl}/reset?token=${rawToken}`;
          await sendMail({
            to: user.email,
            subject: "Reset your password",
            text:
              `Someone requested a password reset for your account.\n\n` +
              `If this was you, follow this link within the next hour:\n\n` +
              `${resetUrl}\n\n` +
              `If not, ignore this email — your password is unchanged.`,
          });
        }
      } catch (err) {
        // Swallow on purpose. A DB or SMTP failure for a valid email must
        // not turn into a different HTTP response than the unknown-email
        // case — that's the enumeration oracle we're avoiding.
        (req.log || logger).error(
          { err },
          "forgot-password: internal failure (response still 204)"
        );
      }
    }
    res.status(204).end();
  })
);

// Public on purpose: the reset token in the body is the authentication.
// The token is single-use, hashed at rest, and expires after one hour.
app.post(
  "/auth/reset-password",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      throw new ValidationError("token and newPassword are required");
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      throw new ValidationError("Password must be at least 8 characters");
    }

    const record = await PasswordResetToken.findOneAndUpdate(
      {
        tokenHash: sha256(token),
        usedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { usedAt: new Date() } },
      { new: false }
    );
    if (!record) {
      throw new ValidationError("Invalid or expired reset token");
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ _id: record.userId }, { $set: { password: hashed } });

    // Revoke every active refresh token for the user — a password reset
    // means we're no longer sure who's holding the previous sessions.
    await RefreshToken.updateMany(
      { userId: record.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    res.status(204).end();
  })
);

// const schemaBuild = schemaComposer.buildSchema();

const buildGraphqlContext = ({ req }) => {
  const header = req.headers.authorization || '';
  const token = header.replace(/^bearer\s+/i, '').trim();
  if (!token) return { user: null };
  try {
    const decoded = jwt.verify(token, process.env.TOKEN_KEY);
    return { user: decoded };
  } catch (err) {
    return { user: null };
  }
};

const isProduction = process.env.NODE_ENV === 'production';

const server = new apollo.ApolloServer({
    schema: schemaComposer.buildSchema(),
    cors: true,
    playground: !isProduction,
    introspection: !isProduction,
    tracing: true,
    path: '/',
    context: buildGraphqlContext,
});

app.get('/api-docs/swagger.json', (req, res) => {
  res.status(200).json(apiSpec);
});
app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(apiSpec));

// Registered here so REST/auth/swagger errors are handled even before
// Apollo finishes its async start. Re-registered below once /graphql/
// has been mounted so its errors flow through the same handler.
app.use(errorHandler);

server.start().then(() => {
  server.applyMiddleware({
      app,
      path: '/graphql/',
      cors: true,
      onHealthCheck: () =>
          // eslint-disable-next-line no-undef
          new Promise((resolve, reject) => {
              if (mongoose.connection.readyState > 0) {
                  resolve();
              } else {
                  reject();
              }
          }),
  });
  app.use(errorHandler);
});

module.exports = app;
