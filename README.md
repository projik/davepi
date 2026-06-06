# dAvePi

[![Agent eval](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fprojik%2Fdavepi%2Fmain%2Feval%2Fresults%2Fbadge.json)](https://docs.davepi.dev/concepts/agent-eval/)

A dynamic REST and GraphQL API server that automatically generates endpoints, documentation, and schemas from simple configuration files.

📚 **Full documentation: <https://docs.davepi.dev>** — concepts, schema reference, per-feature guides, and a flagship "Idea to deployed CRM in 10 minutes" walkthrough. The docs source lives under [`docs/site/`](./docs/site) and ships in lockstep with the framework.

🤖 **Building on dAvePi with Claude Code / Cursor / another agent?** Every scaffolded project ships an [`agent.md`](./templates/_shared/agent.md) (mirrored to `.cursorrules`, `AGENTS.md`, and `.claude/skills/davepi/SKILL.md`) that encodes the framework conventions — read it before adding code, or hand it to your agent. One-line MCP wiring via [`@davepi/mcp`](./packages/mcp) (`npx -y @davepi/mcp`) connects any MCP-aware editor to a hosted or local dAvePi.

📦 **Versioning**: dAvePi follows [semver](https://semver.org/) from v1.0.0 onward — major = breaking, minor = additive, patch = fix. Deprecated APIs surface a warning for at least one full minor release before removal in the next major. See [Stability commitments](https://docs.davepi.dev/reference/stability/) for which APIs are covered, the [CHANGELOG](./CHANGELOG.md) for release notes, and [SECURITY.md](./SECURITY.md) for the disclosure process and supported versions.

🤝 **Community**: [Discussions](https://github.com/projik/davepi/discussions) for Q&A and "show what you built", [issues](https://github.com/projik/davepi/issues/new/choose) for bugs and feature requests, Discord (invite link coming soon). Contributor orientation in [CONTRIBUTING.md](./CONTRIBUTING.md); project conduct in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md); current reviewers in [MAINTAINERS.md](./MAINTAINERS.md).

## Features

- 🚀 **Auto-Generated APIs** - Define schemas, get REST endpoints and GraphQL resolvers automatically
- 🔐 **Built-in Authentication** - JWT-based authentication with user isolation
- 📚 **Automatic Documentation** - Swagger/OpenAPI docs generated from your schemas
- 🔍 **Advanced Querying** - MongoDB query operators via URL parameters
- 📄 **Pagination** - Built-in pagination for all list endpoints
- 🎯 **Type Safety** - Mongoose schemas with validation
- 🔄 **Versioned APIs** - Support for multiple API versions
- ⚡ **GraphQL & REST** - Dual API support out of the box

## Quick Start

### Scaffold a new project (recommended)

```bash
npx create-davepi-app my-app --template crm
cd my-app
docker compose up -d        # local Mongo
npm install
npm start                   # http://localhost:5050
```

Templates: `blank` (minimal), `crm` (accounts/contacts/deals with state machine + aggregations), `ticketing` (two state machines + ACL'd comments), `content` (editorial workflow + file uploads). See [`create-davepi-app`](./create-davepi-app/README.md) for the full flag set; each template has its own README walkthrough under [`templates/`](./templates).

### Prerequisites

- Node.js 18+
- MongoDB Atlas account or local MongoDB instance
- npm or yarn

### Run with Docker (one command)

If you have Docker installed, this is the fastest path:

```bash
docker compose up
```

That brings up MongoDB and the API together. The API waits for Mongo to
report healthy, then nodemon watches the bind-mounted source so edits to
`schema/`, `app.js`, etc. hot-reload inside the container.

Once the stack is running:

- API: <http://localhost:4001>
- Swagger UI: <http://localhost:4001/api-docs>
- Apollo Sandbox: <http://localhost:4001/graphql/> (dev only)
- MongoDB: `mongodb://localhost:27017/davepi`

To rebuild the image after a `package.json` change:

```bash
docker compose build api
```

To stop and clean up:

```bash
docker compose down       # keep the mongo data volume
docker compose down -v    # also drop the data volume
```

The development image targets `dev` in the multi-stage `Dockerfile`. For
a production-shaped image (slim, non-root, no devDeps, no nodemon), build
the default target directly:

```bash
docker build -t davepi:latest .
docker run --rm -p 4001:4001 \
  -e MONGO_URI=mongodb://host.docker.internal:27017/davepi \
  -e TOKEN_KEY=... \
  davepi:latest
```

### Local installation (without Docker)

```bash
# Clone the repository
git clone <repository-url>
cd davepi

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env with your configuration
```

### Environment Configuration

Create a `.env` file in the root directory:

```env
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/database
TOKEN_KEY=your-secret-jwt-key
API_PORT=4001
PAGE_SIZE=20
APP_NAME=dAvePi
NODE_ENV=development
LOG_LEVEL=info
# Comma-separated origin allowlist for CORS. Use "*" to allow any origin
# (not recommended for production). Defaults to http://localhost:3000.
CORS_ORIGINS=http://localhost:3000
```

### Running the Server

```bash
# Development mode with auto-reload
npm start

# Development mode (ignores swagger changes)
npm run dev
```

### Admin UI

[davepi-ui](https://github.com/projik/davepi-ui) — a schema-driven, agent-first React admin built on shadcn primitives. Title-cased field labels by default, searchable relation pickers (not raw UUID inputs), auto-discovered child tabs on parent detail pages, per-resource override layer, JSON page descriptors, and an MCP server for AI agents. Runs as a sibling Vite project pointed at the davepi backend.

```bash
# Scaffold a new davepi project pre-wired with davepi-ui
npx create-davepi-app my-app --template crm

# Or bolt davepi-ui onto an existing project
cd my-existing-project
npx create-davepi-ui admin --api-url http://localhost:4001
```

The scaffolded admin sits at `<project>/admin/`. Run it in a separate terminal:

```bash
cd admin && pnpm install && pnpm dev   # http://localhost:5173
```

Auth uses `/login`; the JWT lives in memory + refresh token in `localStorage`, attached as `Authorization: Bearer …` on every request. Field types come from `/_describe` directly — string fields → text inputs, numbers → number inputs, dates → date pickers, enums → selects, references → searchable combobox pickers, files → multipart upload widget.

The server will start on the configured port (default: 4001).

## Usage

### API Endpoints

Once running, access:

- **REST API**: `http://localhost:4001/api/v1/{resource}`
- **Apollo Sandbox**: `http://localhost:4001/graphql/` (dev only)
- **API Documentation**: `http://localhost:4001/api-docs`
- **Swagger JSON**: `http://localhost:4001/api-docs/swagger.json`

### Authentication

#### Register a New User

```bash
POST /register
Content-Type: application/json

{
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@example.com",
  "password": "securepassword"
}
```

Response includes a JWT token:
```json
{
  "_id": "...",
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@example.com",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### Login

```bash
POST /login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "securepassword"
}
```

#### Using the Token

Include the token in the Authorization header for all protected endpoints:

```bash
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### API keys (long-lived programmatic access)

JWTs are short-lived and meant for interactive sessions. For CI jobs, scripts, and server-to-server callers, mint a long-lived, revocable, scope-limited **API key**. A request bearing an API key resolves to the same identity a JWT would, so tenant scoping, ACLs, and field-level visibility all apply unchanged — on REST **and** GraphQL.

Mint a key (requires a JWT — an API key cannot mint another API key):

```bash
curl -X POST http://localhost:5050/api/auth/api-keys \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{ "name": "CI deploy bot", "scopes": ["read", "write"], "expiresInDays": 90 }'
```

The response includes the plaintext key **once** — store it now; it is never retrievable again:

```json
{ "id": "663...", "prefix": "dpk_a1b2", "key": "dpk_a1b2c3...<96 hex chars>" }
```

Use it exactly like a JWT — as a bearer token:

```bash
curl http://localhost:5050/api/v1/product \
  -H "Authorization: Bearer dpk_a1b2c3..."
```

- **Body fields:** `name` (required), `scopes` (optional, a non-empty subset of `["read", "write"]`; defaults to both), `expiresInDays` (optional, positive number; omit for a non-expiring key).
- **Scopes** are coarse: `read` permits `GET` / GraphQL queries, `write` permits `POST`/`PUT`/`DELETE` / GraphQL mutations. A key missing the required scope is refused with `403`. (JWT sessions carry both scopes implicitly — no behaviour change.)
- **Roles** are frozen from the minting user at creation and read from the key on every request, so a key can never be elevated past what its owner held when it was minted.
- Only the SHA-256 hash of the key is stored. A revoked or expired key returns `401`.

List your keys (the secret and its hash are never returned):

```bash
curl http://localhost:5050/api/auth/api-keys -H "Authorization: Bearer $JWT"
```

Revoke a key:

```bash
curl -X DELETE http://localhost:5050/api/auth/api-keys/$KEY_ID \
  -H "Authorization: Bearer $JWT"
```

#### Public read access (no login, no JWT)

For storefronts, marketing sites, and any other unauthenticated frontend, dAvePi resolves an `X-Client-Id` request header into a role. The header value is a public client ID issued through the admin-only `apiClient` resource — bake it into your SPA bundle.

1. As an admin, issue a client ID:

```bash
curl -X POST http://localhost:5050/api/v1/apiClient \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_id": "pk_storefront_live_abc123",
    "name": "storefront-prod",
    "role": "storefront"
  }'
```

2. On the schema you want exposed, declare which role bypasses owner scope and the mandatory filter that limits what they can see:

```js
module.exports = {
  path: 'product',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true },
    { name: 'price', type: Number },
    { name: 'published', type: Boolean, default: false },
    { name: 'cost', type: Number, acl: { read: ['admin', 'user'] } },
  ],
  acl: {
    list: ['storefront', 'admin'],
    scope: { storefront: { published: true } },
  },
};
```

3. From the storefront, send the header:

```bash
curl http://localhost:5050/api/v1/product \
  -H "X-Client-Id: pk_storefront_live_abc123"
```

The role sees only records matching `acl.scope.storefront` (here: `published: true`), and fields without `storefront` in their `acl.read` are stripped from responses. The filter is server-controlled and cannot be widened by the caller. Writes from client-authed callers are refused with 403. When both `Authorization` and `X-Client-Id` are present, the Bearer wins.

Client IDs are public identifiers (not secrets). Rotate by flipping the row's `status` to `"revoked"` and redeploying with a fresh ID.

### Working with Resources

#### Create a Record

```bash
POST /api/v1/account
Authorization: Bearer {token}
Content-Type: application/json

{
  "accountName": "My Account",
  "description": "Account description"
}
```

#### List Records (with pagination)

```bash
GET /api/v1/account?__page=1&__sort=createdAt:desc
Authorization: Bearer {token}
```

Response:
```json
{
  "results": [...],
  "totalResults": 45,
  "page": 1,
  "perPage": 20,
  "totalPages": 3,
  "nextPage": 2
}
```

#### Query with Filters

Using mongo-querystring syntax:

```bash
GET /api/v1/account?accountName=Test&createdAt=>2024-01-01
Authorization: Bearer {token}
```

#### Get Single Record

```bash
GET /api/v1/account/{id}
Authorization: Bearer {token}
```

#### Update Record

```bash
PUT /api/v1/account/{id}
Authorization: Bearer {token}
Content-Type: application/json

{
  "accountName": "Updated Name"
}
```

#### Delete Record

```bash
DELETE /api/v1/account/{id}
Authorization: Bearer {token}
```

### GraphQL Usage

Access the Apollo Sandbox at `http://localhost:4001/graphql/` (served outside production, gated on `introspection`)

#### Example Query

```graphql
query {
  accountMany {
    _id
    accountName
    description
    createdAt
    updatedAt
  }
}
```

#### Example Mutation

```graphql
mutation {
  accountCreateOne(record: {
    accountName: "New Account"
    description: "Created via GraphQL"
  }) {
    recordId
    record {
      _id
      accountName
      description
    }
  }
}
```

## Creating New Resources

The magic of dAvePi is in its schema-driven approach. To add a new resource:

### 1. Create a Schema File

Create a new file in `./schema/versions/v1/{resource}.js`:

```javascript
module.exports = {
  path: 'task',
  collection: 'tasks',
  fields: [
    {
      name: 'userId',
      type: String,
      required: true
    },
    {
      name: 'title',
      type: String,
      required: true
    },
    {
      name: 'description',
      type: String
    },
    {
      name: 'status',
      type: String,
      default: 'pending',
      enum: ['pending', 'in-progress', 'completed']
    },
    {
      name: 'dueDate',
      type: Date
    },
    {
      name: 'priority',
      type: Number,
      default: 0
    }
  ]
};
```

### 2. That's It!

If you started the server with `HOT_RELOAD_SCHEMAS=true npm start` (dev
only), the new file is picked up automatically — REST routes,
GraphQL resolvers, and Swagger documentation update without a restart.
Editing or deleting the file is reflected the same way.

Without the flag, restart the server to pick up the new schema:

```bash
npm start
```

### 3. Your new resource is live

Your new resource now has:
- ✅ REST endpoints at `/api/v1/task`
- ✅ GraphQL queries and mutations
- ✅ Swagger documentation
- ✅ Automatic validation
- ✅ User isolation
- ✅ Timestamps

## Schema Field Options

```javascript
{
  name: 'fieldName',        // Field name (required)
  type: String,             // Mongoose type: String, Number, Date, Boolean, etc.
  required: true,           // Make field required
  unique: true,             // Enforce uniqueness
  index: true,              // Create index
  default: 'value',         // Default value
  enum: ['a', 'b', 'c'],   // Allowed values
  reference: 'otherModel'   // Reference to another model (auto-populated)
}
```

### Composite Indexes

For unique combinations of fields:

```javascript
module.exports = {
  path: 'resource',
  collection: 'resources',
  fields: [...],
  compositeIndex: [
    { userId: 1, email: 1 }  // Unique combination
  ]
};
```

## Advanced Querying

The API supports MongoDB query operators via URL parameters using [mongo-querystring](https://github.com/fox1t/mongo-querystring):

```bash
# Greater than
GET /api/v1/task?priority=>5

# Less than or equal
GET /api/v1/task?priority=<=3

# Not equal
GET /api/v1/task?status=!completed

# In array
GET /api/v1/task?status=pending,in-progress

# Regular expression
GET /api/v1/task?title=/^Important/

# Date range
GET /api/v1/task?dueDate=>2024-01-01&dueDate=<2024-12-31

# Sorting
GET /api/v1/task?__sort=priority:desc

# Pagination
GET /api/v1/task?__page=2
```

## Project Structure

```
davepi/
├── app.js                    # Main application logic
├── index.js                  # Server entry point
├── package.json              # Dependencies
├── config/
│   └── database.js          # MongoDB connection
├── middleware/
│   └── auth.js              # JWT authentication
├── model/
│   └── user.js              # User model
├── schema/
│   └── versions/
│       └── v1/              # Schemas (auto-loaded)
│           ├── account.js
│           ├── category.js
│           ├── contact.js
│           ├── product.js
│           ├── project.js
│           └── quote.js
├── routes/                  # Custom routes
├── swagger/                 # Generated Swagger files
└── utils/                   # Utility functions
```

## API Layout

Schemas live in `./schema/versions/v1/` and are served under `/api/v1/{resource}`. The framework derives the `/api/v1` path prefix from the directory name, so dropping a schema file into that folder is all it takes to expose its full REST and GraphQL surface.

## Built With

- **[Express](https://expressjs.com/)** - Web framework
- **[Mongoose](https://mongoosejs.com/)** - MongoDB ODM
- **[Apollo Server](https://www.apollographql.com/docs/apollo-server/)** - GraphQL server
- **[graphql-compose-mongoose](https://github.com/graphql-compose/graphql-compose-mongoose)** - GraphQL schema generation
- **[JWT](https://jwt.io/)** - Authentication
- **[Swagger UI](https://swagger.io/tools/swagger-ui/)** - API documentation
- **[bcryptjs](https://github.com/dcodeIO/bcrypt.js)** - Password hashing
- **[mongo-querystring](https://github.com/fox1t/mongo-querystring)** - Query parsing

## Security

- 🔒 Passwords hashed with bcrypt (10 salt rounds)
- 🎫 JWT tokens expire after 2 hours
- 👤 User isolation - users can only access their own data
- 🔐 Environment variables for sensitive configuration
- 🛡️ CORS enabled (configure for production)

## Development

### Adding Custom Endpoints

Add custom routes in `app.js` after the auto-generated routes (after line 426):

```javascript
app.get('/api/v1/custom-endpoint', auth(true), async (req, res) => {
  // Your custom logic
  res.status(200).json({ message: 'Custom endpoint' });
});
```

### Extending dAvePi

Beyond CRUD ("DAVE"), there are two officially supported extension points:

**1. Per-resource lifecycle hooks** — declare on the schema file:

```js
module.exports = {
  path: 'order',
  collection: 'order',
  fields: [...],
  hooks: {
    beforeCreate: async ({ input, user }) => ({ ...input, code: generateCode() }),
    afterCreate:  async ({ record }) => sendConfirmationEmail(record),
    beforeDelete: async ({ current }) => {
      if (current.locked) throw new ForbiddenError('record is locked');
    },
  },
};
```

`before*` hooks can mutate the input and reject via throw; `after*` hooks are best-effort. Coverage: REST single-record `POST` / `PUT /:id` / `DELETE /:id` and the matching GraphQL `*One` / `*ById` mutations. See `AGENTS.md` for the full signature reference.

**2. Plugins** — global extensions registered in your `package.json`:

```json
{
  "davepi": {
    "plugins": ["./plugins/my-plugin.js"]
  }
}
```

```js
// ./plugins/my-plugin.js
module.exports = {
  name: 'my-plugin',
  async setup({ app, schemaLoader, bus, log }) {
    app.get('/api/v1/_status', (req, res) => res.json({ schemas: schemaLoader.listSchemas() }));
    bus.on('record', (e) => log.info({ event: e.type, id: e.recordId }, 'observed'));
  },
};
```

Plugins are loaded after every initial schema is registered, so a plugin can introspect the registry and wire a route per resource.

### Debugging

The application includes extensive console logging. Check the terminal output for:
- Database connection status
- Schema loading
- Query execution
- Error messages

## Troubleshooting

### Server won't start

- ✅ Check MongoDB connection string in `.env`
- ✅ Verify all required environment variables are set
- ✅ Ensure MongoDB cluster is accessible

### Authentication errors

- ✅ Verify `TOKEN_KEY` is set in `.env`
- ✅ Check token hasn't expired (2 hour limit)
- ✅ Ensure `Authorization: Bearer {token}` header format

### No data returned

- ✅ Verify user is authenticated
- ✅ Check that records belong to the authenticated user
- ✅ Review console logs for query details

### Endpoints not generating

- ✅ Verify schema file is in correct directory
- ✅ Check schema file syntax
- ✅ Restart the server, or run with `HOT_RELOAD_SCHEMAS=true` for live reload

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the ISC License - see the LICENSE file for details.

## Author

**David Baxter**

## Acknowledgments

- Built with modern Node.js best practices
- Inspired by schema-first API development
- Designed for rapid prototyping and production use

---

**For AI Agents**: See [AGENTS.md](./AGENTS.md) for detailed technical documentation and development guidelines.
