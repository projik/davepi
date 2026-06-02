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

  test('Apollo Studio Sandbox is allowed in dev (Playground works out of the box)', async () => {
    // Apollo Server v3's playground=true redirects to studio.apollographql.com,
    // which then XHRs the local /graphql endpoint. Allow it when we serve
    // the Playground (i.e. outside production).
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const app = buildAppWithCors('http://localhost:3000');
      const res = await supertest(app)
        .get('/ping')
        .set('Origin', 'https://studio.apollographql.com');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://studio.apollographql.com');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('Apollo Studio Sandbox is NOT allowed in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = buildAppWithCors('http://localhost:3000');
      const res = await supertest(app)
        .get('/ping')
        .set('Origin', 'https://studio.apollographql.com');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CORS_NOT_ALLOWED');
    } finally {
      process.env.NODE_ENV = prev;
    }
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

  test('allows same-origin requests (Origin matches Host) regardless of allowlist', async () => {
    // CORS_ORIGINS deliberately set to a different origin so the only
    // reason this should succeed is the same-origin bypass.
    const app = buildAppWithCors('https://app.example.com');
    const res = await supertest(app)
      .get('/ping')
      .set('Host', 'api.example.com')
      .set('Origin', 'http://api.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://api.example.com');
  });

  test('still rejects cross-origin even when Host coincidentally matches a different origin', async () => {
    // Defense check: an attacker page at evil.example.com fetching
    // api.example.com sets Host=api.example.com but Origin=evil.example.com.
    // The mismatch keeps us on the allowlist path.
    const app = buildAppWithCors('https://app.example.com');
    const res = await supertest(app)
      .get('/ping')
      .set('Host', 'api.example.com')
      .set('Origin', 'http://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORS_NOT_ALLOWED');
  });

  test('same-origin bypass is case-insensitive on the hostname', async () => {
    const app = buildAppWithCors('https://allowed.example.com');
    const res = await supertest(app)
      .get('/ping')
      .set('Host', 'API.Example.COM')
      .set('Origin', 'http://api.example.com');
    expect(res.status).toBe(200);
  });

  test('same-origin bypass tolerates default-port differences (http:80)', async () => {
    const app = buildAppWithCors('https://allowed.example.com');
    const res = await supertest(app)
      .get('/ping')
      .set('Host', 'api.example.com:80')
      .set('Origin', 'http://api.example.com');
    expect(res.status).toBe(200);
  });

  test('same-origin bypass tolerates default-port differences (https:443)', async () => {
    const app = buildAppWithCors('https://allowed.example.com');
    const res = await supertest(app)
      .get('/ping')
      .set('Host', 'api.example.com:443')
      .set('Origin', 'https://api.example.com');
    expect(res.status).toBe(200);
  });

  test('same-origin bypass honors X-Forwarded-Host when trust proxy is enabled', async () => {
    // Trust-proxy deployments (Caddy / nginx / a PaaS LB in front of
    // the app) terminate TLS upstream and rewrite Host to the
    // internal target. The original externally-visible host travels
    // in X-Forwarded-Host. The bypass needs to use that to match
    // the Origin the browser actually saw.
    const app = express();
    app.set('trust proxy', 1);
    app.use(buildCorsMiddleware('https://allowed.example.com'));
    app.get('/ping', (req, res) => res.status(200).json({ ok: true }));
    app.use(errorHandler);

    const res = await supertest(app)
      .get('/ping')
      .set('Host', '127.0.0.1:5050')                       // internal proxy target
      .set('X-Forwarded-Host', 'api.example.com')          // external hostname
      .set('Origin', 'https://api.example.com');
    expect(res.status).toBe(200);
  });

  test('does NOT trust X-Forwarded-Host when trust proxy is disabled', async () => {
    // Without trust proxy, an attacker could try to bypass CORS by
    // setting X-Forwarded-Host to match Origin. The bypass should
    // ignore X-Forwarded-Host entirely in that case.
    const app = buildAppWithCors('https://allowed.example.com');
    const res = await supertest(app)
      .get('/ping')
      .set('Host', '127.0.0.1:5050')
      .set('X-Forwarded-Host', 'evil.example.com')
      .set('Origin', 'http://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORS_NOT_ALLOWED');
  });
});
