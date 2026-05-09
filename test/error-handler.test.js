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

  await new Promise((r) => setTimeout(r, 500));
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

const register = (overrides = {}) =>
  request(app)
    .post('/register')
    .send({
      first_name: 'Err',
      last_name: 'Test',
      email: 'err@test.com',
      password: 'pw12345!',
      ...overrides,
    });

describe('Centralized error handler', () => {
  let token;

  beforeAll(async () => {
    const res = await register({ email: 'err-suite@test.com' });
    token = res.body.token;
  });

  describe('error response shape', () => {
    test('every error returns { error: { code, message } }', async () => {
      const res = await request(app).post('/login').send({ email: '' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { code: 'VALIDATION', message: 'All input is required' },
      });
    });
  });

  describe('/register', () => {
    test('missing fields returns 400 VALIDATION (not a hung request)', async () => {
      const res = await request(app)
        .post('/register')
        .send({ email: 'x@x.com' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toBe('All input is required');
    });

    test('duplicate email returns 409 CONFLICT', async () => {
      await register({ email: 'dup@x.com' });
      const res = await register({ email: 'dup@x.com' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    test('successful register still returns 201 with token', async () => {
      const res = await register({ email: 'fresh@x.com' });
      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
      expect(res.body.password).toBeUndefined();
    });
  });

  describe('/login', () => {
    test('missing credentials returns 400 VALIDATION', async () => {
      const res = await request(app).post('/login').send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    test('invalid credentials returns 400 VALIDATION', async () => {
      const res = await request(app)
        .post('/login')
        .send({ email: 'nobody@x.com', password: 'wrong' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toBe('Invalid Credentials');
    });
  });

  describe('REST CRUD errors', () => {
    test('GET /:id with bogus ObjectId returns 400 INVALID_ID (CastError mapped)', async () => {
      const res = await request(app)
        .get('/api/v1/account/not-an-objectid')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ID');
    });

    test('GET /:id for missing record returns 404 NOT_FOUND', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .get(`/api/v1/account/${fakeId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toBe('account not found');
    });

    test('DELETE /:id for missing record returns 404 NOT_FOUND', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .delete(`/api/v1/account/${fakeId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('PUT /:id for missing record returns 404 NOT_FOUND', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .put(`/api/v1/account/${fakeId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ accountName: 'whatever' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('POST without required field returns 400 VALIDATION (Mongoose ValidationError mapped)', async () => {
      const res = await request(app)
        .post('/api/v1/account')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toMatch(/accountName/);
    });

    test('successful CRUD round-trip still works', async () => {
      const create = await request(app)
        .post('/api/v1/account')
        .set('Authorization', `Bearer ${token}`)
        .send({ accountName: 'Happy Path' });
      expect(create.status).toBe(201);
      expect(create.body.accountName).toBe('Happy Path');

      const id = create.body._id;
      const getOne = await request(app)
        .get(`/api/v1/account/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(getOne.status).toBe(200);
      expect(getOne.body._id).toBe(id);

      const list = await request(app)
        .get('/api/v1/account')
        .set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.body.results).toBeInstanceOf(Array);
    });
  });

  describe('middleware mappings (unit)', () => {
    const mockRes = () => ({
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    });

    test('Mongoose 11000 duplicate-key error maps to 409 DUPLICATE with offending field', () => {
      const errorHandler = require('../middleware/errorHandler');
      const res = mockRes();
      const err = Object.assign(new Error('E11000 duplicate'), {
        code: 11000,
        keyValue: { email: 'dup@x.com' },
      });
      errorHandler(err, {}, res, () => {});
      expect(res.statusCode).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE');
      expect(res.body.error.message).toContain('email');
    });

    test('AppError subclasses pass through with their declared status and code', () => {
      const errorHandler = require('../middleware/errorHandler');
      const { NotFoundError } = require('../utils/errors');
      const res = mockRes();
      errorHandler(new NotFoundError('widget'), {}, res, () => {});
      expect(res.statusCode).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toBe('widget not found');
    });
  });

  describe('production hardening', () => {
    test('production hides raw error messages for unknown errors', () => {
      const errorHandler = require('../middleware/errorHandler');
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const res = {
        statusCode: 200,
        headersSent: false,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        },
      };

      const rawErr = new Error('sensitive: secret table name xyz');
      // not an AppError, not a Mongoose error -> generic message in prod
      errorHandler(rawErr, {}, res, () => {});

      process.env.NODE_ENV = original;

      expect(res.statusCode).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL');
      expect(res.body.error.message).toBe('Internal server error');
      expect(res.body.error.message).not.toContain('sensitive');
    });

    test('non-production keeps raw messages for debuggability', () => {
      const errorHandler = require('../middleware/errorHandler');
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      const res = {
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        },
      };

      const rawErr = new Error('actual debug info');
      errorHandler(rawErr, {}, res, () => {});

      process.env.NODE_ENV = original;

      expect(res.body.error.message).toBe('actual debug info');
    });
  });
});
