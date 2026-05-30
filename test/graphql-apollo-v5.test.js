// Regression coverage for the Apollo Server v3 → v5 migration
// (issue #91). Two invariants the migration must preserve, both
// asserted with NODE_ENV=production so the production code paths
// (introspection gate + Apollo's production error masking) are the
// ones under test:
//
//   1. introspection is OFF in production — a `__schema` query is
//      rejected, so the schema can't be enumerated by an anonymous
//      caller. (`introspection: !isProduction()` in schemaLoader.)
//   2. the typed-error invariant holds through v5's two-arg
//      `formatError`: framework errors keep their `extensions.code`
//      (UNAUTHENTICATED / FORBIDDEN / …) instead of being masked to
//      INTERNAL_SERVER_ERROR the way an un-coded throw would be.
//
// This file sets NODE_ENV=production *before* requiring app.js so the
// schema is composed with the production gates. Jest gives each test
// file its own module registry, so this doesn't leak into the suites
// that boot in `test` mode.

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongo;
let app;
let request;
let prevNodeEnv;
let prevLogLevel;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({
    instance: { launchTimeout: 60000 },
  });
  process.env.MONGO_URI = mongo.getUri();
  process.env.TOKEN_KEY = 'test-secret';
  process.env.PAGE_SIZE = '20';
  process.env.API_PORT = '0';
  // Boot the app in production mode so introspection is gated off and
  // Apollo applies its production error masking. Silence the logger —
  // it isn't auto-silenced outside NODE_ENV=test.
  prevNodeEnv = process.env.NODE_ENV;
  prevLogLevel = process.env.LOG_LEVEL;
  process.env.NODE_ENV = 'production';
  process.env.LOG_LEVEL = 'silent';

  await mongoose.connect(process.env.MONGO_URI);

  app = require('../app');
  request = require('supertest');

  if (app.locals && app.locals.ready) await app.locals.ready;
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
  process.env.NODE_ENV = prevNodeEnv;
  if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = prevLogLevel;
});

const register = async (email) => {
  const res = await request(app)
    .post('/register')
    .send({ first_name: 'A', last_name: 'B', email, password: 'pw12345!' });
  return res.body;
};

const gql = (token, query, variables) => {
  const r = request(app).post('/graphql/').send({ query, variables });
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r;
};

describe('Apollo Server v5 — production hardening', () => {
  test('introspection is disabled in production', async () => {
    const res = await gql(null, 'query { __schema { queryType { name } } }');
    // Introspection-off rejects the operation before execution, so
    // there's no data and the error mentions introspection.
    expect(res.body.errors).toBeDefined();
    expect(res.body.data == null || res.body.data.__schema == null).toBe(true);
    expect(
      res.body.errors.some((e) => /introspection/i.test(e.message))
    ).toBe(true);
  });

  test('typed GraphQL errors keep extensions.code in production (not masked)', async () => {
    // An un-coded throw would be reduced to INTERNAL_SERVER_ERROR with
    // a generic message in production. Our AuthenticationError carries
    // a GraphQLError code, so it survives v5's formatError verbatim.
    const res = await gql(null, 'query { accountMany { _id } }');
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  test('authenticated resolvers still run with introspection off', async () => {
    const user = await register('prod-user@x.com');
    expect(user.accessToken).toBeDefined();
    const res = await gql(
      user.accessToken,
      'mutation { accountCreateOne(record: { accountName: "prod" }) { record { _id userId accountName } } }'
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.accountCreateOne.record.userId).toBe(user.user._id);
    expect(res.body.data.accountCreateOne.record.accountName).toBe('prod');
  });
});
