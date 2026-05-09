const express = require('express');
const supertest = require('supertest');

const { buildAuthLimiter } = require('../middleware/rateLimit');
const { buildCorsMiddleware, parseOrigins } = require('../middleware/corsConfig');
const errorHandler = require('../middleware/errorHandler');

describe('Auth rate limiter', () => {
  test('returns 429 once max is exceeded within the window', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/login',
      buildAuthLimiter({
        windowMs: 60 * 1000,
        max: 3,
        skip: () => false, // override the test-mode bypass for this assertion
      })
    );
    app.post('/login', (req, res) => res.status(200).json({ ok: true }));

    const request = supertest(app);

    for (let i = 0; i < 3; i++) {
      const res = await request.post('/login').send({});
      expect(res.status).toBe(200);
    }

    const blocked = await request.post('/login').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
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

  test('rejects an origin outside the allowlist', async () => {
    const app = buildAppWithCors('https://app.example.com');
    const res = await supertest(app)
      .get('/ping')
      .set('Origin', 'https://evil.example.com');
    // cors throws -> errorHandler returns 500 with INTERNAL code
    expect(res.status).toBe(500);
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
    expect(blocked.status).toBe(500);
  });
});
