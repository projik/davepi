# dAvePi

A dynamic REST and GraphQL API server that automatically generates endpoints, documentation, and schemas from simple configuration files.

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

### Prerequisites

- Node.js 14+
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
- GraphQL Playground: <http://localhost:4001/graphql>
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

The server will start on the configured port (default: 4001).

## Usage

### API Endpoints

Once running, access:

- **REST API**: `http://localhost:4001/api/v1/{resource}`
- **GraphQL Playground**: `http://localhost:4001/graphql`
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

Access the GraphQL Playground at `http://localhost:4001/graphql`

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

### 2. Restart the Server

```bash
npm start
```

### 3. That's It!

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
│       └── v1/              # API version 1 schemas
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

## API Versioning

Schemas are organized by version in `./schema/versions/`:

- `v1/` - Version 1 endpoints at `/api/v1/{resource}`
- `v2/` - Version 2 endpoints at `/api/v2/{resource}` (future)

Multiple versions can coexist, allowing gradual migrations.

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
- ✅ Restart the server

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
