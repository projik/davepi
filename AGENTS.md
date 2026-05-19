# AGENTS.md - AI Agent Guide for dAvePi

## Project Overview

**dAvePi** (also referenced as `davepi`) is a dynamic REST and GraphQL API server built with Node.js, Express, MongoDB, and Apollo Server. The system automatically generates API endpoints, Swagger documentation, and GraphQL schemas from schema definitions.

**Key Feature**: Schema-driven architecture that auto-generates CRUD endpoints, GraphQL resolvers, and API documentation.

## Architecture

### Core Components

1. **Entry Point**: `index.js` - Starts the Express server
2. **Application Core**: `app.js` - Main application logic, route generation, and server configuration
3. **Database**: MongoDB (Mongoose ODM) with automatic schema generation
4. **Authentication**: JWT-based with Bearer token middleware
5. **API Types**: 
   - REST API with auto-generated CRUD endpoints
   - GraphQL API with Apollo Server
   - Swagger/OpenAPI documentation

### Directory Structure

```
/Users/davidbaxter/Projects/davepi/
├── app.js                    # Main application logic
├── index.js                  # Server entry point
├── config/
│   └── database.js          # MongoDB connection configuration
├── middleware/
│   └── auth.js              # JWT authentication middleware
├── model/
│   └── user.js              # User model (manual definition)
├── routes/
│   └── auth/                # Authentication routes
├── schema/
│   └── versions/
│       └── v1/              # Version 1 schemas (auto-loaded)
│           ├── account.js
│           ├── category.js
│           ├── contact.js
│           ├── product.js
│           ├── project.js
│           └── quote.js
├── swagger/                 # Swagger documentation files
├── utils/                   # Utility functions
└── package.json            # Dependencies and scripts
```

## Schema-Driven Development

### How Schemas Work

The application uses `directory-tree` to automatically discover and load schema files from `./schema/versions/`. Each schema file defines:

- **path**: API endpoint path
- **collection**: MongoDB collection name
- **fields**: Array of field definitions with type, validation, and constraints
- **compositeIndex** (optional): Composite unique indexes

### Schema File Format

```javascript
module.exports = {
  path: 'resource-name',
  collection: 'collection-name',
  fields: [
    {
      name: 'fieldName',
      type: String,          // Mongoose type
      required: true,        // Validation
      unique: false,         // Unique constraint
      index: false,          // Index field
      default: null,         // Default value
      reference: 'other'     // Reference to another model
    }
  ],
  compositeIndex: [         // Optional composite indexes
    { field1: 1, field2: 1 }
  ]
};
```

### Auto-Generated Features

For each schema, the system automatically creates:

1. **Mongoose Schema & Model** with timestamps (`createdAt`, `updatedAt`)
2. **REST Endpoints**:
   - `POST /api/v1/{path}` - Create record
   - `GET /api/v1/{path}` - List records (paginated, queryable)
   - `PUT /api/v1/{path}` - Bulk update
   - `GET /api/v1/{path}/:id` - Get single record
   - `PUT /api/v1/{path}/:id` - Update single record
   - `DELETE /api/v1/{path}/:id` - Delete record
   - `GET /api/v1/{path}-schema` - Get JSON schema

3. **GraphQL Resolvers**:
   - Queries: `{path}ById`, `{path}ByIds`, `{path}One`, `{path}Many`, `{path}Count`, `{path}Connection`, `{path}Pagination`
   - Mutations: `{path}CreateOne`, `{path}CreateMany`, `{path}UpdateById`, `{path}UpdateOne`, `{path}UpdateMany`, `{path}RemoveById`, `{path}RemoveMany`

4. **Swagger Documentation** at `/api-docs`

## Authentication & Authorization

### User Registration & Login

- **Register**: `POST /register` - Creates user with bcrypt-hashed password, returns JWT token
- **Login**: `POST /login` - Validates credentials, returns JWT token

### JWT Middleware

Located in `./middleware/auth.js`:
- Accepts boolean parameter to enable/disable auth requirement
- Extracts token from `Authorization: Bearer {token}` header
- Validates token using `TOKEN_KEY` from environment
- Attaches decoded user to `req.user` with `user_id` and `email`

### User Isolation

All auto-generated endpoints enforce user isolation:
- `POST` requests: Automatically set `userId` and `accountId` to `req.user.user_id`
- `GET/PUT/DELETE` requests: Filter by `userId` to ensure users only access their own data

## Query Features

### mongo-querystring

The API uses `mongo-querystring` for advanced querying:
- Supports MongoDB query operators in URL parameters
- Example: `?name=John&age=>25` translates to MongoDB query

### Pagination

- Default page size from `PAGE_SIZE` environment variable
- Query params:
  - `__page`: Page number (1-indexed)
  - `__sort`: Sort field and direction (e.g., `createdAt:desc`)
- Response includes: `results`, `totalResults`, `page`, `perPage`, `totalPages`, `nextPage`, `prevPage`

## Environment Variables

Required in `.env` file:

```
MONGO_USER=<mongodb-username>
MONGO_PASSWORD=<mongodb-password>
MONGO_URI=<mongodb-cluster-uri>
TOKEN_KEY=<jwt-secret-key>
API_PORT=<port-number>
PAGE_SIZE=<items-per-page>
APP_NAME=<application-name>
NODE_ENV=<development|production>
```

## Key Dependencies

- **express**: Web framework
- **mongoose**: MongoDB ODM
- **apollo-server-express**: GraphQL server
- **graphql-compose-mongoose**: Auto-generate GraphQL from Mongoose
- **jsonwebtoken**: JWT authentication
- **bcryptjs**: Password hashing
- **swagger-ui-express**: API documentation
- **mongoose-to-swagger**: Convert Mongoose schemas to Swagger
- **mongo-querystring**: Query string parsing
- **directory-tree**: Schema file discovery
- **async**: Async flow control
- **lodash**: Utility functions

## Development Workflow

### Adding New Resources

1. Create schema file in `./schema/versions/v1/{resource}.js`
2. Define fields with proper types and constraints
3. Restart server - endpoints auto-generate
4. Access at `/api/v1/{resource}` (REST) or `/graphql` (GraphQL)
5. View documentation at `/api-docs`

### Running the Application

```bash
npm start          # Start with nodemon (auto-reload)
npm run dev        # Dev mode (ignores swagger changes)
```

### Testing Endpoints

- **Swagger UI**: `http://localhost:{port}/api-docs`
- **GraphQL Playground**: `http://localhost:{port}/graphql`
- **Swagger JSON**: `http://localhost:{port}/api-docs/swagger.json`

## Important Patterns

### Reference Fields

When a field has `reference: 'otherModel'`:
- The field stores an ObjectId
- `GET /:id` endpoints automatically populate referenced documents
- Uses `async.each` to resolve references in response

### Error Handling

- **409 Conflict**: Duplicate unique field violation
- **404 Not Found**: Resource not found or unauthorized access
- **403 Forbidden**: Missing authentication token
- **401 Unauthorized**: Invalid token
- **500 Internal Server Error**: Server errors

### Timestamps

All schemas automatically include:
- `createdAt`: Record creation timestamp
- `updatedAt`: Last update timestamp
- Indexed for efficient querying

## GraphQL Schema Composition

The system uses `graphql-compose` and `graphql-compose-mongoose` to:
1. Convert Mongoose models to GraphQL types
2. Generate standard resolvers (CRUD operations)
3. Compose into unified schema via `SchemaComposer`
4. Serve via Apollo Server at `/graphql`

## Code Modification Guidelines

### When Adding Features

1. **New Schema Fields**: Add to schema file, restart server
2. **Custom Endpoints**: Add after auto-generated routes in `app.js`, OR register a plugin (see "Extensibility" below) if davepi is installed as a dep
3. **Middleware**: Place in `./middleware/` directory
4. **Models**: Manual models go in `./model/` (like `user.js`)
5. **Utilities**: Add to `./utils/` directory
6. **Per-resource side effects** (validate before persist, fire a notification on create, refuse delete if a dependent exists): declare a `hooks` block on the schema — see "Extensibility" below
7. **Cross-cutting extensions** (integrations, scheduled jobs, audit exports): register a plugin — see "Extensibility" below

## Extensibility

dAvePi exposes two extension points beyond the auto-generated CRUD surface. Pick the one that matches the scope of the work.

### Schema lifecycle hooks (per resource)

Declare a `hooks` block on the schema definition. Hook signatures:

```js
hooks: {
  beforeCreate: async ({ input, user, req, schema }) => input,    // can mutate / replace input, throw to reject
  afterCreate:  async ({ record, user, req, schema }) => {},      // best-effort, throws are logged
  beforeUpdate: async ({ input, current, user, req, schema }) => input,
  afterUpdate:  async ({ record, previous, user, req, schema }) => {},
  beforeDelete: async ({ current, user, req, schema }) => {},     // throw to refuse delete
  afterDelete:  async ({ record, user, req, schema }) => {},
}
```

Posture:
- `before*` hooks run synchronously. Returning a value replaces the input that gets persisted; returning `undefined` keeps it. Throwing a typed error from `utils/errors.js` rejects the operation through the centralised `errorHandler`.
- `after*` hooks run after persistence and are best-effort — a thrown error is logged but does not fail the response. Use this slot for fan-out (emails, webhooks, derived caches) where retryability matters less than not blocking the client.
- **Coverage**: REST `POST` / `PUT /:id` / `DELETE /:id` and GraphQL `{path}CreateOne` / `{path}UpdateById` / `{path}RemoveById`. Bulk paths (REST bulk `PUT`, GraphQL `createMany` / `updateMany` / `removeMany`) intentionally do not invoke hooks — subscribe to the event bus from a plugin if you need bulk reactions.

### Plugins (cross-cutting)

List plugin module specifiers under `davepi.plugins` in the **consumer project's** `package.json` (not davepi's own):

```json
{
  "davepi": {
    "plugins": [
      "./plugins/audit-export.js",
      "davepi-plugin-slack"
    ]
  }
}
```

Each plugin module exports:

```js
module.exports = {
  name: 'audit-export',
  async setup({ app, schemaLoader, bus, log, appName }) {
    app.get('/api/v1/_audit-export', auth(true), handler);
    bus.on('record', (event) => { /* event.type === '<path>.created|updated|deleted' */ });
  },
};
```

- `app` — the Express app, so `app.use(...)` and `app.<verb>(...)` work. Errors propagate through the framework's `errorHandler` because the loader re-asserts it at the tail of the middleware stack after every plugin is loaded.
- `schemaLoader` — the live registry (`listSchemas`, `getEntry`, `runAggregation`, `onChange`). Plugins commonly use `listSchemas()` to wire a route per resource.
- `bus` — the same `EventEmitter` from `utils/events.js` that fires `record` events for every CRUD mutation. Composes with the existing webhook dispatcher.
- `log` — a pino child logger keyed by plugin name.
- `appName` — convenience for context.

Plugins run after every initial schema is loaded, in declaration order, and are awaited. A throw during `setup` fails boot — silent dropping would hide misconfiguration from operators.

### When Debugging

1. Check console logs - extensive logging throughout
2. Verify schema definitions match Mongoose types
3. Ensure environment variables are set
4. Check MongoDB connection
5. Validate JWT token format and expiration

### Code Style

- Uses CommonJS modules (`require`/`module.exports`)
- Async/await for database operations
- Callback-based async flow control with `async` library
- Lodash for utility functions (e.g., `_.camelCase`)

## Security Considerations

1. **Password Storage**: Bcrypt with salt rounds = 10
2. **Token Expiration**: JWT tokens expire in 2 hours
3. **User Isolation**: All queries filtered by `userId`
4. **Environment Secrets**: Never commit `.env` file
5. **CORS**: Enabled globally (configure for production)

## Common Tasks for AI Agents

### Task: Add a New Resource

1. Create file: `./schema/versions/v1/{resource}.js`
2. Define schema with required fields
3. Restart server to auto-generate endpoints

### Task: Modify Existing Schema

1. Locate schema in `./schema/versions/v1/`
2. Update field definitions
3. Consider data migration for existing records
4. Restart server

### Task: Add Custom Endpoint

1. Add route definition in `app.js` after line 426
2. Use `auth(true)` middleware for protected routes
3. Access `req.user.user_id` for user context
4. Follow existing error handling patterns

### Task: Debug Authentication Issues

1. Check `TOKEN_KEY` in environment
2. Verify token format: `Authorization: Bearer {token}`
3. Check token expiration (2 hour limit)
4. Review `./middleware/auth.js` for token validation

### Task: Query Data

1. Use mongo-querystring syntax in URL params
2. Add `__page` and `__sort` for pagination/sorting
3. Filter by any schema field
4. Check response pagination metadata

## GraphQL Usage

Access GraphQL Playground at `http://localhost:{port}/graphql`

Example queries:
```graphql
query {
  accountMany {
    _id
    accountName
    description
    createdAt
  }
}

mutation {
  accountCreateOne(record: {
    accountName: "Test Account"
    description: "Test Description"
  }) {
    recordId
    record {
      _id
      accountName
    }
  }
}
```

## Troubleshooting

### Server Won't Start
- Check MongoDB connection credentials
- Verify all environment variables are set
- Check for syntax errors in schema files

### Endpoints Not Generating
- Verify schema file is in `./schema/versions/v1/`
- Check schema file exports valid module
- Restart server with `npm start`

### Authentication Failing
- Verify token is included in header
- Check token hasn't expired
- Ensure `TOKEN_KEY` matches between registration and validation

### Data Not Returning
- Check user is authenticated
- Verify `userId` matches record owner
- Check MongoDB query in console logs

## Version Control

- Schemas are versioned in `./schema/versions/v1/`, `v2/`, etc.
- API endpoints include version: `/api/v1/{resource}`
- Multiple versions can coexist

---

**Last Updated**: October 2025  
**Maintainer**: David Baxter  
**Node Version**: Compatible with Node.js 14+
