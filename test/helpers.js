const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

/**
 * Shared lifecycle for tests that need the real Express app + Mongo.
 *
 * Usage in a test file:
 *
 *   const { setupTestApp } = require('./helpers');
 *   const ctx = setupTestApp();
 *   // ctx.app, ctx.request, ctx.mongo are populated after beforeAll runs.
 *
 * Caller can pass `cleanCollections: true` (default) to drop all
 * collection data after each test for isolation.
 */
function setupTestApp({ cleanCollections = true } = {}) {
  const ctx = { app: null, request: null, mongo: null };

  beforeAll(async () => {
    ctx.mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60000 },
    });
    process.env.MONGO_URI = ctx.mongo.getUri();
    process.env.TOKEN_KEY = process.env.TOKEN_KEY || 'test-secret';
    process.env.PAGE_SIZE = process.env.PAGE_SIZE || '20';
    process.env.NODE_ENV = 'test';
    process.env.API_PORT = '0';

    await mongoose.connect(process.env.MONGO_URI);

    ctx.app = require('../app');
    ctx.request = require('supertest');

    // Apollo Server applyMiddleware is called inside server.start().then(...)
    // — give it a tick so /graphql/ is mounted before tests fire requests.
    await new Promise((r) => setTimeout(r, 500));
  }, 60000);

  if (cleanCollections) {
    afterEach(async () => {
      const collections = mongoose.connection.collections;
      await Promise.all(
        Object.values(collections).map((c) => c.deleteMany({}))
      );
    });
  }

  afterAll(async () => {
    await mongoose.disconnect();
    if (ctx.mongo) await ctx.mongo.stop();
  });

  return ctx;
}

/**
 * Convenience: register a test user and return a flattened
 * { _id, email, token, accessToken, refreshToken, user } object.
 *
 * `token` is an alias for `accessToken` (kept so older test code that
 * referenced `body.token` keeps working).
 */
async function registerUser(request, app, overrides = {}) {
  const body = {
    first_name: 'Test',
    last_name: 'User',
    email: `u${Date.now()}-${Math.random().toString(36).slice(2, 8)}@x.com`,
    password: 'pw12345!',
    ...overrides,
  };
  const res = await request(app).post('/register').send(body);
  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const { accessToken, refreshToken, user } = res.body;
  return {
    ...user,
    accessToken,
    refreshToken,
    token: accessToken,
    user,
  };
}

module.exports = { setupTestApp, registerUser };
