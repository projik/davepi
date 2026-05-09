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

  if (app.locals && app.locals.ready) await app.locals.ready;
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('x-request-id header sanitization', () => {
  test('a request without x-request-id gets a generated UUID echoed back', async () => {
    const res = await request(app).post('/login').send({});
    expect(res.headers['x-request-id']).toMatch(UUID_RE);
  });

  test('a valid x-request-id is echoed back as-is', async () => {
    const id = 'abc.123_request-id';
    const res = await request(app)
      .post('/login')
      .set('x-request-id', id)
      .send({});
    expect(res.headers['x-request-id']).toBe(id);
  });

  test('an x-request-id with disallowed characters is replaced with a UUID', async () => {
    const res = await request(app)
      .post('/login')
      .set('x-request-id', 'has space and <html>')
      .send({});
    expect(res.headers['x-request-id']).toMatch(UUID_RE);
  });

  test('an oversized x-request-id is replaced with a UUID', async () => {
    const res = await request(app)
      .post('/login')
      .set('x-request-id', 'a'.repeat(200))
      .send({});
    expect(res.headers['x-request-id']).toMatch(UUID_RE);
  });
});
