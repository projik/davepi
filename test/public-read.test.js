const { setupTestApp, registerUser } = require('./helpers');
const ApiClient = require('../model/apiClient');
const User = require('../model/user');

const ctx = setupTestApp();

/**
 * Storefront-style product schema. Anonymous storefront callers
 * (resolved via `X-Client-Id` to the `storefront` role) may list +
 * get records, but only those matching `acl.scope.storefront`. A
 * standard authenticated user sees only records they own.
 */
const productSchema = {
  path: 'public_product',
  collection: 'public_products',
  version: 'v1',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true },
    { name: 'price', type: Number },
    { name: 'published', type: Boolean, default: false },
    {
      name: 'cost',
      type: Number,
      acl: { read: ['admin', 'user'] },
    },
  ],
  acl: {
    list: ['storefront', 'admin'],
    scope: {
      storefront: { published: true },
    },
  },
};

const post = (path, body, token, headers = {}) => {
  const r = ctx.request(ctx.app).post(path).send(body);
  if (token) r.set('Authorization', `Bearer ${token}`);
  Object.entries(headers).forEach(([k, v]) => r.set(k, v));
  return r;
};
const get = (path, token, headers = {}) => {
  const r = ctx.request(ctx.app).get(path);
  if (token) r.set('Authorization', `Bearer ${token}`);
  Object.entries(headers).forEach(([k, v]) => r.set(k, v));
  return r;
};
const del = (path, token, headers = {}) => {
  const r = ctx.request(ctx.app).delete(path);
  if (token) r.set('Authorization', `Bearer ${token}`);
  Object.entries(headers).forEach(([k, v]) => r.set(k, v));
  return r;
};

const issueClient = async ({ id, role, status = 'active' }) => {
  await ApiClient.deleteOne({ _id: id });
  await ApiClient.create({
    _id: id,
    name: `${id}-test`,
    role,
    status,
    userId: 'system',
  });
};

describe('Public read via X-Client-Id', () => {
  let owner;

  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema(productSchema);
  });

  beforeEach(async () => {
    owner = await registerUser(ctx.request, ctx.app, { email: 'owner@x.com' });
    await post(
      '/api/v1/public_product',
      { name: 'Draft Widget', price: 10, cost: 4, published: false },
      owner.accessToken
    ).expect(201);
    await post(
      '/api/v1/public_product',
      { name: 'Live Widget', price: 20, cost: 7, published: true },
      owner.accessToken
    ).expect(201);
    await issueClient({ id: 'pk_storefront_test', role: 'storefront' });
  });

  describe('REST list', () => {
    test('returns only records matching acl.scope[storefront]', async () => {
      const res = await get('/api/v1/public_product', null, {
        'X-Client-Id': 'pk_storefront_test',
      }).expect(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].name).toBe('Live Widget');
    });

    test('scope filter cannot be widened via query params', async () => {
      const res = await get(
        '/api/v1/public_product?published=false',
        null,
        { 'X-Client-Id': 'pk_storefront_test' }
      ).expect(200);
      expect(res.body.results).toHaveLength(0);
    });

    test('field-level read ACL strips `cost` for the storefront role', async () => {
      const res = await get('/api/v1/public_product', null, {
        'X-Client-Id': 'pk_storefront_test',
      }).expect(200);
      expect(res.body.results[0].cost).toBeUndefined();
      expect(res.body.results[0].price).toBe(20);
    });

    test('missing client ID still 403s on auth-required route', async () => {
      await get('/api/v1/public_product').expect(403);
    });

    test('unknown client ID 401s', async () => {
      await get('/api/v1/public_product', null, {
        'X-Client-Id': 'pk_does_not_exist',
      }).expect(401);
    });

    test('revoked client ID 401s', async () => {
      await issueClient({
        id: 'pk_revoked',
        role: 'storefront',
        status: 'revoked',
      });
      await get('/api/v1/public_product', null, {
        'X-Client-Id': 'pk_revoked',
      }).expect(401);
    });

    test('Bearer wins when both headers present', async () => {
      const res = await get('/api/v1/public_product', owner.accessToken, {
        'X-Client-Id': 'pk_storefront_test',
      }).expect(200);
      // Owner sees both their records (Bearer auth, owner scope), not just published.
      expect(res.body.results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('REST get-by-id', () => {
    test('unpublished record is 404 for storefront role', async () => {
      const list = await get('/api/v1/public_product', owner.accessToken).expect(200);
      const draft = list.body.results.find((r) => r.name === 'Draft Widget');
      await get(`/api/v1/public_product/${draft._id}`, null, {
        'X-Client-Id': 'pk_storefront_test',
      }).expect(404);
    });

    test('published record is fetchable', async () => {
      const list = await get('/api/v1/public_product', owner.accessToken).expect(200);
      const live = list.body.results.find((r) => r.name === 'Live Widget');
      const res = await get(`/api/v1/public_product/${live._id}`, null, {
        'X-Client-Id': 'pk_storefront_test',
      }).expect(200);
      expect(res.body.name).toBe('Live Widget');
      expect(res.body.cost).toBeUndefined();
    });
  });

  describe('Write protection', () => {
    test('POST with X-Client-Id is refused', async () => {
      await post(
        '/api/v1/public_product',
        { name: 'Hacker Widget', published: true },
        null,
        { 'X-Client-Id': 'pk_storefront_test' }
      ).expect(403);
    });

    test('DELETE with X-Client-Id is refused', async () => {
      const list = await get('/api/v1/public_product', owner.accessToken).expect(200);
      const live = list.body.results.find((r) => r.name === 'Live Widget');
      await del(`/api/v1/public_product/${live._id}`, null, {
        'X-Client-Id': 'pk_storefront_test',
      }).expect(403);
    });
  });

  describe('GraphQL parity', () => {
    test('public_productMany returns only scoped records', async () => {
      const res = await ctx
        .request(ctx.app)
        .post('/graphql/')
        .set('X-Client-Id', 'pk_storefront_test')
        .send({ query: '{ public_productMany { name published } }' })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      const names = res.body.data.public_productMany.map((r) => r.name);
      expect(names).toEqual(['Live Widget']);
    });
  });
});

describe('apiClient admin surface', () => {
  let admin;

  beforeAll(async () => {
    // Schema already loaded at app boot — no extra registration needed.
  });

  beforeEach(async () => {
    const u = await registerUser(ctx.request, ctx.app, { email: 'admin@x.com' });
    await User.updateOne({ _id: u._id }, { $set: { roles: ['admin'] } });
    const login = await ctx
      .request(ctx.app)
      .post('/login')
      .send({ email: 'admin@x.com', password: 'pw12345!' });
    admin = { ...u, accessToken: login.body.accessToken };
  });

  test('admin can issue a client ID via REST', async () => {
    const res = await post(
      '/api/v1/apiClient',
      {
        _id: 'pk_partner_alpha',
        name: 'partner-alpha',
        role: 'partner',
      },
      admin.accessToken
    ).expect(201);
    expect(res.body._id).toBe('pk_partner_alpha');
    expect(res.body.role).toBe('partner');
  });

  test('non-admin user cannot list clients', async () => {
    const u = await registerUser(ctx.request, ctx.app, { email: 'plain@x.com' });
    const res = await get('/api/v1/apiClient', u.accessToken).expect(200);
    // Plain user is owner-scoped; they own nothing.
    expect(res.body.results).toEqual([]);
  });
});
