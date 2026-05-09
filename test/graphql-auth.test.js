const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongo;
let app;
let request;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({
    instance: { launchTimeout: 60000 },
  });
  process.env.MONGO_URI = mongo.getUri();
  process.env.TOKEN_KEY = 'test-secret';
  process.env.PAGE_SIZE = '20';
  process.env.NODE_ENV = 'test';
  process.env.API_PORT = '0';

  await mongoose.connect(process.env.MONGO_URI);

  app = require('../app');
  request = require('supertest');

  // Apollo applyMiddleware mounts /graphql asynchronously
  await new Promise((r) => setTimeout(r, 500));
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

const register = (email) =>
  request(app)
    .post('/register')
    .send({ first_name: 'A', last_name: 'B', email, password: 'pw12345!' });

const gql = (token, query, variables) => {
  const r = request(app).post('/graphql/').send({ query, variables });
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r;
};

describe('GraphQL auth and user isolation', () => {
  let userA;
  let userB;
  let aRecordId;

  beforeAll(async () => {
    userA = (await register('a@x.com')).body;
    userB = (await register('b@x.com')).body;
    expect(userA.token).toBeDefined();
    expect(userB.token).toBeDefined();
  });

  test('unauthenticated query is rejected with AuthenticationError', async () => {
    const res = await gql(null, 'query { accountMany { _id } }');
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    // accountMany returned null after the resolver threw
    expect(res.body.data == null || res.body.data.accountMany == null).toBe(true);
  });

  test('unauthenticated mutation is rejected', async () => {
    const res = await gql(
      null,
      'mutation { accountCreateOne(record: { accountName: "x" }) { recordId } }'
    );
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  test('invalid token is rejected', async () => {
    const res = await gql('not-a-real-token', 'query { accountMany { _id } }');
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  test('User A creates a record with userId stamped from token', async () => {
    const res = await gql(
      userA.token,
      'mutation { accountCreateOne(record: { accountName: "A-secret" }) { recordId record { _id userId accountName } } }'
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.accountCreateOne.record.userId).toBe(userA._id);
    expect(res.body.data.accountCreateOne.record.accountName).toBe('A-secret');
    aRecordId = res.body.data.accountCreateOne.recordId;
  });

  test('input type rejects client-supplied userId (cannot impersonate)', async () => {
    const res = await gql(
      userB.token,
      `mutation { accountCreateOne(record: { accountName: "spoof", userId: "${userA._id}" }) { recordId } }`
    );
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  test('User A sees own records via findMany', async () => {
    const res = await gql(userA.token, 'query { accountMany { _id userId accountName } }');
    expect(res.body.data.accountMany).toHaveLength(1);
    expect(res.body.data.accountMany[0].userId).toBe(userA._id);
  });

  test('User B does NOT see User A records via findMany', async () => {
    const res = await gql(userB.token, 'query { accountMany { _id } }');
    expect(res.body.data.accountMany).toEqual([]);
  });

  test('User B does NOT see User A records via accountCount', async () => {
    const res = await gql(userB.token, 'query { accountCount }');
    expect(res.body.data.accountCount).toBe(0);
  });

  test('User B cannot fetch User A record by id', async () => {
    const res = await gql(userB.token, `query { accountById(_id: "${aRecordId}") { _id accountName } }`);
    expect(res.body.data.accountById).toBeNull();
  });

  test('User B cannot delete User A record (returns FORBIDDEN)', async () => {
    const res = await gql(
      userB.token,
      `mutation { accountRemoveById(_id: "${aRecordId}") { recordId } }`
    );
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  test('User B cannot update User A record (returns FORBIDDEN)', async () => {
    const res = await gql(
      userB.token,
      `mutation { accountUpdateById(_id: "${aRecordId}", record: { accountName: "hijacked" }) { recordId } }`
    );
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  test('removeMany with empty filter does not affect other users', async () => {
    const res = await gql(userB.token, 'mutation { accountRemoveMany(filter: {}) { numAffected } }');
    expect(res.body.data.accountRemoveMany.numAffected).toBe(0);
  });

  test('User A record survives all User B attacks', async () => {
    const res = await gql(userA.token, 'query { accountMany { _id accountName } }');
    expect(res.body.data.accountMany).toHaveLength(1);
    expect(res.body.data.accountMany[0].accountName).toBe('A-secret');
  });

  test('User B can still create their own record', async () => {
    const res = await gql(
      userB.token,
      'mutation { accountCreateOne(record: { accountName: "B-only" }) { record { _id userId accountName } } }'
    );
    expect(res.body.data.accountCreateOne.record.userId).toBe(userB._id);
  });

  test('User A and User B see only their own records after both have data', async () => {
    const aList = await gql(userA.token, 'query { accountMany { accountName } }');
    const bList = await gql(userB.token, 'query { accountMany { accountName } }');
    expect(aList.body.data.accountMany.map((r) => r.accountName)).toEqual(['A-secret']);
    expect(bList.body.data.accountMany.map((r) => r.accountName)).toEqual(['B-only']);
  });
});
