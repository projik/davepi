const express = require('express');
const supertest = require('supertest');

const { buildAuthLimiter } = require('../middleware/rateLimit');
const { buildCorsMiddleware, parseOrigins } = require('../middleware/corsConfig');
const errorHandler = require('../middleware/errorHandler');

describe('Auth rate limiter', () => {
  test('11th /login attempt within a 15-minute window returns 429', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/login',
      buildAuthLimiter({
        windowMs: 15 * 60 * 1000, // matches production window
        max: 10, // matches production threshold
        skip: () => false, // override the test-mode bypass for this assertion
      })
    );
    app.post('/login', (req, res) => res.status(200).json({ ok: true }));

    const request = supertest(app);

    for (let i = 1; i <= 10; i++) {
      const res = await request.post('/login').send({});
      expect(res.status).toBe(200);
    }

    const eleventh = await request.post('/login').send({});
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('RATE_LIMITED');
  });

  test('skips during NODE_ENV=test by default', async () => {
    const app = express();
    app.use(express.json());
    app.use('/login', buildAuthLimiter({ windowMs: 60 * 1000, max: 1 }));
    app.post('/login', (req, res) => res.status(200).json({ ok: true }));

    const request = supertest(app);

    // 5 calls should all succeed because skip() returns true in test mode
    for (let i = 0; i < 5; i++) {
      const res = await request.post('/login').send({});
      expect(res.status).toBe(200);
    }
  });
});

describe('helmet scoping (integration)', () => {
  let mongo;
  let app;
  let request;

  beforeAll(async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mongoose = require('mongoose');
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
    process.env.MONGO_URI = mongo.getUri();
    process.env.TOKEN_KEY = 'test-secret';
    process.env.PAGE_SIZE = '20';
    process.env.NODE_ENV = 'test';
    process.env.API_PORT = '0';
    process.env.CORS_ORIGINS = '*';

    await mongoose.connect(process.env.MONGO_URI);

    app = require('../app');
    request = require('supertest');
    if (app.locals && app.locals.ready) await app.locals.ready;
  }, 60000);

  afterAll(async () => {
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  test('non-tooling routes get the default helmet CSP header', async () => {
    const res = await request(app).post('/login').send({});
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  test('/api-docs/swagger.json does NOT get a CSP header (Swagger UI carve-out)', async () => {
    const res = await request(app).get('/api-docs/swagger.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
    // Other helmet headers still present
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('/admin/* does NOT get a CSP header (ant-design inline-styles carve-out)', async () => {
    // The admin SPA uses ant-design which emits inline styles per
    // dynamic component. The default CSP's `style-src 'self'` would
    // make the UI render unstyled in production. Verify the carve-out
    // applies regardless of whether the SPA bundle is built.
    const res = await request(app).get('/admin/anything');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CORS middleware', () => {
  const buildAppWithCors = (origins) => {
    const app = express();
    app.use(buildCorsMiddleware(origins));
    app.get('/ping', (req, res) => res.status(200).json({ ok: true }));
    app.use(errorHandler);
    return app;
  };

  test('parseOrigins splits, trims, and ignores empties', () => {
    expect(parseOrigins('a, b ,, c')).toEqual(['a', 'b', 'c']);
    expect(parseOrigins('')).toEqual([]);
    expect(parseOrigins(undefined)).toEqual([]);
  });

  test('allows requests from an origin in the allowlist', async () => {
    const app = buildAppWithCors('https://app.example.com');
    const res = await supertest(app)
      .get('/ping')
      .set('Origin', 'https://app.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  test('rejects an origin outside the allowlist with 403 CORS_NOT_ALLOWED', async () => {
    const app = buildAppWithCors('https://app.example.com');
    const res = await supertest(app)
      .get('/ping')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORS_NOT_ALLOWED');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('allows requests with no Origin header (curl, server-to-server)', async () => {
    const app = buildAppWithCors('https://app.example.com');
    const res = await supertest(app).get('/ping');
    expect(res.status).toBe(200);
  });

  test('"*" allows any origin', async () => {
    const app = buildAppWithCors('*');
    const res = await supertest(app)
      .get('/ping')
      .set('Origin', 'https://anywhere.example.com');
    expect(res.status).toBe(200);
  });

  test('unset CORS_ORIGINS falls back to http://localhost:3000', async () => {
    const app = buildAppWithCors('');
    const ok = await supertest(app)
      .get('/ping')
      .set('Origin', 'http://localhost:3000');
    expect(ok.status).toBe(200);

    const blocked = await supertest(app)
      .get('/ping')
      .set('Origin', 'https://other.example.com');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('CORS_NOT_ALLOWED');
  });
});
