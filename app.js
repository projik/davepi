require("dotenv").config();
require("./config/database").connect();
const express = require("express");
const cors = require('cors');
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

app.use(cors());
app.use(express.json());

const qs = new MongoQS();

const filteredTree = dirTree("./schema/versions", { extensions: /\.js/ });
const schemas = [];
filteredTree.children.forEach((t) => {
  // console.log(t);
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
  // console.log(s);
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
  // console.log(swaggerSchema);
  const postSchema = m2s(model[path], { omitFields: ['_id', 'createdAt', 'updatedAt']});
  const putSchema = JSON.parse(JSON.stringify(postSchema));
  delete putSchema.required;
  console.log('ps', postSchema);
  swaggerSchema.type = 'object';
  apiSpec.definitions[path] = swaggerSchema;
  // apiSpec.definitions[`update-${path}`] = putSchema;
  app.get(`/api/${s.version}/${path}-schema`, async (req, res) => {
    const jsSchema = schema[path].jsonSchema();
    console.log(jsSchema);
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

  app.post(`/api/${s.version}/${path}`, auth(true), async (req, res) => {
    try {
      const data = req.body;
      data.accountId = req.user.user_id;
      data.userId = req.user.user_id;
      console.log(req.user);
      console.log(data);
      const record = await model[path].create(data);
      res.status(201).send(record);
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).send('Duplicate record error. [' + unique.join(', ') + '] must be unique.');
      }
      console.log('err', err);
      res.status(500).send(err.message);
    }
  });

  app.get(`/api/${s.version}/${path}`, auth(true), async (req, res) => {
    const pageSize = parseInt(PAGE_SIZE);
    const page = parseInt(req.query.__page) || 1;
    const sort = req.query.__sort || false;
    const sortObject = {};
    if (sort) {
      var vals = sort.split(':');
      sortObject[vals[0]] = vals[1];
    }
    var querystring = {...req.query};
    Object.keys(req.query).forEach((q) => {
      if (q.startsWith('__')) delete querystring[q];
    });
    const query = qs.parse(querystring);
    query['userId'] = req.user.user_id;
    console.log(query);
      async.parallel({
        list: (done) => {
          try {
            model[path].find(query).sort(sortObject).skip((page - 1) * pageSize).limit(pageSize).exec((err, records) => {
              done(err, records)
            });
          } catch (err) {
            done(err)
          }
        },
        count: (done) => {
          try {
            model[path].find(query).countDocuments((err, count) => {
              done(null, count);
            });
          } catch (err) {
            done(err);
          }
        }
      }, (err, results) => {
        console.log(err);
        if (err) {
          return res.status(500).send({ err });
        } else {
          let totalPages = Math.ceil(results.count / pageSize);
          if (references.length > 0) {
            console.log(references);
          }
          const result = {
            results: results.list,
            totalResults: results.count,
            page: page,
            perPage: pageSize,
            totalPages: totalPages
          };
          if (totalPages > page) {
            result.nextPage = page + 1;
          };
          if (page > 1) {
            result.prevPage = page - 1;
          }
          return res.status(200).send(result);
        }
      });
  });

  app.put(`/api/${s.version}/${path}`, auth(true), async (req, res) => {
    try {
      const query = qs.parse(req.query);
      query['userId'] = req.user.user_id;
      console.log(query);
      console.log(req.body);
      const record = await model[path].updateMany(query,  { $set: req.body }, { upsert: true });
      res.status(200).send(record);
    } catch (err) {
      console.log('err', err);
      res.status(404).send({error: 'not found'});
    }
  });

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
  app.get(`/api/${s.version}/${path}/:id`, auth(true), async (req, res) => {
    try {
      const query = {
        userId: req.user.user_id,
        _id: req.params.id
      }
      const record = await model[path].findOne(query);
      if (!record) {
        return res.status(404).send({error: 'not found'});
      }
      const copy = JSON.parse(JSON.stringify(record));
      async.each(references, async (r, done) => {
        const ref = await model[r].findById(copy[r]).lean().exec();
        console.log(copy[r]);
        console.log(ref);
        copy[r] = JSON.parse(JSON.stringify(ref));
      console.log(copy[r]);
        done(null)
      }, (err) => {
      console.log(copy);
        res.status(200).send(copy);
      })
    } catch (err) {
      console.log('err', err);
      res.status(404).send({error: 'not found'});
    }
  });

  app.delete(`/api/${s.version}/${path}/:id`, auth(true), async (req, res) => {
    try {
      const query = {
        userId: req.user.user_id,
        _id: req.params.id
      }
      const record = await model[path].deleteOne(query);
      res.status(200).send(record);
    } catch (err) {
      console.log('err', err);
      res.status(404).send({error: 'not found'});
    }
  });

  app.put(`/api/${s.version}/${path}/:id`, auth(true), async (req, res) => {
    try {
      const query = {
        userId: req.user.user_id,
        _id: req.params.id
      }
      const record = await model[path].updateOne(query, { $set: req.body });
      res.status(200).send(record);
    } catch (err) {
      console.log('err', err);
      res.status(404).send({error: 'not found'});
    }
  });

});
// Logic goes here
// importing user context
const User = require("./model/user");

// Register
/**
 * Create a new user in our database and return the user with a token.
 * @param req - The request object.
 * @param res - The response object.
 * @returns A new user object with a token
 */
app.post("/register", async (req, res) => {

  // Our register logic starts here
  try {
    // Get user input
    console.log(req.body);
    const { first_name, last_name, email, password } = req.body;

    // Validate user input
    if (!(email && password && first_name && last_name)) {
      return res.json({ status: 'error', code: 400, message: "All input is required"});
    }

    // check if user already exist
    // Validate if user exist in our database
    const oldUser = await User.findOne({ email });

    if (oldUser) {
      return res.json({ status: 'error', code: 409, message:"User Already Exists. Please Login" });
    }

    //Encrypt user password
    const encryptedPassword = await bcrypt.hash(password, 10);

    // Create user in our database
    const user = await User.create({
      first_name,
      last_name,
      email: email.toLowerCase(), // sanitize: convert email to lowercase
      password: encryptedPassword,
    });

    // Create token
    const token = jwt.sign(
      { user_id: user._id, email },
      process.env.TOKEN_KEY,
      {
        expiresIn: "2h",
      }
    );
    // save user token
    user.token = token;
    const response = JSON.parse(JSON.stringify(user));

    // return new user
    delete response.password;
    delete response.__v;

    return res.status(201).json(response);
  } catch (err) {
    console.log(err);
  }
  // Our register logic ends here
});
// Login
app.post("/login", async (req, res) => {

  // Our login logic starts here
  try {
    // Get user input
    const { email, password } = req.body;

    // Validate user input
    if (!(email && password)) {
      res.status(400).send("All input is required");
    }
    // Validate if user exist in our database
    const user = await User.findOne({ email }, { first_name: 1, last_name: 1, email: 1, password: 1 });

    if (user && (await bcrypt.compare(password, user.password))) {
      // Create token
      const token = jwt.sign(
        { user_id: user._id, email },
        process.env.TOKEN_KEY,
        {
          expiresIn: "2h",
        }
      );

      // save user token
      user.token = token;
      const response = JSON.parse(JSON.stringify(user));
      delete response.password;
      
      // user
      return res.status(200).json(response);
    }
    res.status(400).send("Invalid Credentials");
  } catch (err) {
    console.log(err);
  }
  // Our register logic ends here
});

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

const server = new apollo.ApolloServer({
    schema: schemaComposer.buildSchema(),
    cors: true,
    playground: process.env.NODE_ENV === 'development' ? true : false,
    introspection: true,
    tracing: true,
    path: '/',
    context: buildGraphqlContext,
});

server.start().then(res => {
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
});

app.get('/api-docs/swagger.json', (req, res) => {
  res.status(200).json(apiSpec);
});
app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(apiSpec));
module.exports = app;
