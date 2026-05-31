const { setupTestApp, registerUser } = require('./helpers');
const ApiKey = require('../model/apiKey');
const ApiClient = require('../model/apiClient');
const { sha256 } = require('../utils/tokens');

const ctx = setupTestApp();

const bearer = (r, token) => r.set('Authorization', `Bearer ${token}`);

// Mint an API key for a JWT-authenticated user and return the plaintext.
const mintKey = async (jwt, body = { name: 'CI deploy bot' }) => {
  const res = await bearer(
    ctx.request(ctx.app).post('/api/auth/api-keys'),
    jwt
  ).send(body);
  return res;
};

describe('API keys: minting', () => {
  test('mint returns plaintext once and persists only the hash', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const res = await mintKey(user.token);

    expect(res.status).toBe(201);
    expect(res.body.key).toEqual(expect.any(String));
    expect(res.body.key.startsWith('dpk_')).toBe(true);
    expect(res.body.prefix).toBe(res.body.key.slice(0, 8));
    expect(res.body.id).toEqual(expect.any(String));

    // The plaintext is never stored — only its sha256.
    const record = await ApiKey.findById(res.body.id);
    expect(record).not.toBeNull();
    expect(record.tokenHash).toBe(sha256(res.body.key));
    expect(record.scopes).toEqual(['read', 'write']);
    // Roles frozen from the minting user (defaults to ['user']).
    expect(record.roles).toEqual(['user']);
  });

  test('the returned plaintext authenticates a subsequent request', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const minted = await mintKey(user.token);

    // Use the API key (not the JWT) to read a schema route.
    const res = await bearer(
      ctx.request(ctx.app).get('/api/v1/account'),
      minted.body.key
    );
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);

    // lastUsedAt is bumped on use.
    const record = await ApiKey.findById(minted.body.id);
    expect(record.lastUsedAt).not.toBeNull();
  });

  test('a write-capable key can create records owned by the minting user', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const minted = await mintKey(user.token);

    const created = await bearer(
      ctx.request(ctx.app).post('/api/v1/account'),
      minted.body.key
    ).send({ accountName: 'via-api-key' });
    expect(created.status).toBe(201);
    expect(created.body.accountName).toBe('via-api-key');
    // Stamped to the key owner, not the key.
    expect(created.body.userId).toBe(user._id);
  });

  test('rejects an empty name and an invalid scope set', async () => {
    const user = await registerUser(ctx.request, ctx.app);

    const noName = await mintKey(user.token, {});
    expect(noName.status).toBe(400);

    const badScope = await mintKey(user.token, {
      name: 'x',
      scopes: ['read', 'admin'],
    });
    expect(badScope.status).toBe(400);
  });
});

describe('API keys: listing', () => {
  test('listing never reveals the secret or its hash', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    await mintKey(user.token, { name: 'key-a' });
    await mintKey(user.token, { name: 'key-b' });

    const res = await bearer(
      ctx.request(ctx.app).get('/api/auth/api-keys'),
      user.token
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const k of res.body) {
      expect(k.tokenHash).toBeUndefined();
      expect(k.key).toBeUndefined();
      expect(k.prefix).toEqual(expect.any(String));
      expect(k.name).toEqual(expect.any(String));
    }
  });

  test('listing is scoped to the calling user', async () => {
    const a = await registerUser(ctx.request, ctx.app, { email: 'la@x.com' });
    const b = await registerUser(ctx.request, ctx.app, { email: 'lb@x.com' });
    await mintKey(a.token, { name: 'a-key' });

    const res = await bearer(
      ctx.request(ctx.app).get('/api/auth/api-keys'),
      b.token
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('API keys: revocation and expiry', () => {
  test('a revoked key returns 401', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const minted = await mintKey(user.token);

    const del = await bearer(
      ctx.request(ctx.app).delete(`/api/auth/api-keys/${minted.body.id}`),
      user.token
    );
    expect(del.status).toBe(204);

    const res = await bearer(
      ctx.request(ctx.app).get('/api/v1/account'),
      minted.body.key
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('an expired key returns 401', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const minted = await mintKey(user.token, {
      name: 'short-lived',
      expiresInDays: 1,
    });

    // Backdate the expiry so the lookup predicate rejects it.
    await ApiKey.updateOne(
      { _id: minted.body.id },
      { $set: { expiresAt: new Date(Date.now() - 60 * 1000) } }
    );

    const res = await bearer(
      ctx.request(ctx.app).get('/api/v1/account'),
      minted.body.key
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('revoking another user\'s key is a 404 (tenant-scoped)', async () => {
    const a = await registerUser(ctx.request, ctx.app, { email: 'ra@x.com' });
    const b = await registerUser(ctx.request, ctx.app, { email: 'rb@x.com' });
    const minted = await mintKey(a.token);

    const del = await bearer(
      ctx.request(ctx.app).delete(`/api/auth/api-keys/${minted.body.id}`),
      b.token
    );
    expect(del.status).toBe(404);
  });
});

describe('API keys: scope enforcement', () => {
  test('a read-only key is 403 on a POST to a schema route', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const minted = await mintKey(user.token, {
      name: 'read-only',
      scopes: ['read'],
    });

    // Reads still work.
    const read = await bearer(
      ctx.request(ctx.app).get('/api/v1/account'),
      minted.body.key
    );
    expect(read.status).toBe(200);

    // Writes are refused.
    const write = await bearer(
      ctx.request(ctx.app).post('/api/v1/account'),
      minted.body.key
    ).send({ accountName: 'nope' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('FORBIDDEN');
  });

  test('a write-only key is 403 on a GET to a schema route', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const minted = await mintKey(user.token, {
      name: 'write-only',
      scopes: ['write'],
    });

    const read = await bearer(
      ctx.request(ctx.app).get('/api/v1/account'),
      minted.body.key
    );
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe('FORBIDDEN');
  });

  test('read-only key enforced on GraphQL mutations too', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const minted = await mintKey(user.token, {
      name: 'gql-read-only',
      scopes: ['read'],
    });

    const res = await bearer(
      ctx.request(ctx.app).post('/graphql/'),
      minted.body.key
    ).send({
      query:
        'mutation { accountCreateOne(record: { accountName: "x" }) { record { _id } } }',
    });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/scope/i);
  });
});

describe('API keys: privilege boundaries', () => {
  test('an API-key request cannot mint another API key', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const minted = await mintKey(user.token);

    const res = await bearer(
      ctx.request(ctx.app).post('/api/auth/api-keys'),
      minted.body.key
    ).send({ name: 'second-gen' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('an X-Client-Id caller cannot list or manage API keys', async () => {
    // Public client IDs (storefronts etc.) resolve to a synthetic
    // req.user for GET requests; the key-management routes must refuse
    // them outright rather than running a tenant query under the
    // client principal.
    const clientId = 'pk_apikey_probe_001';
    await ApiClient.deleteOne({ _id: clientId });
    await ApiClient.create({
      _id: clientId,
      name: 'apikey-probe',
      role: 'storefront',
      status: 'active',
      userId: 'system',
    });

    const res = await ctx
      .request(ctx.app)
      .get('/api/auth/api-keys')
      .set('X-Client-Id', clientId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('an X-Client-Id caller cannot run a GraphQL state-transition mutation', async () => {
    // wrapStateTransition is a write path — client-authed callers must
    // be refused before any record lookup, like every other write
    // wrapper. `skill.status` carries a state machine, so the
    // skillTransitionStatus mutation exists.
    const clientId = 'pk_apikey_probe_002';
    await ApiClient.deleteOne({ _id: clientId });
    await ApiClient.create({
      _id: clientId,
      name: 'apikey-probe-2',
      role: 'storefront',
      status: 'active',
      userId: 'system',
    });

    const res = await ctx
      .request(ctx.app)
      .post('/graphql/')
      .set('X-Client-Id', clientId)
      .send({
        query:
          'mutation { skillTransitionStatus(_id: "0123456789abcdef01234567", to: approved) { _id } }',
      });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/read-only/i);
  });

  test('tenant isolation: user A\'s key cannot read user B\'s docs', async () => {
    const a = await registerUser(ctx.request, ctx.app, { email: 'ta@x.com' });
    const b = await registerUser(ctx.request, ctx.app, { email: 'tb@x.com' });

    // User B creates a record under their own tenant.
    const bRecord = await bearer(
      ctx.request(ctx.app).post('/api/v1/account'),
      b.token
    ).send({ accountName: 'b-secret' });
    expect(bRecord.status).toBe(201);

    // User A mints a key and lists accounts — sees only their own (none).
    const minted = await mintKey(a.token);
    const list = await bearer(
      ctx.request(ctx.app).get('/api/v1/account'),
      minted.body.key
    );
    expect(list.status).toBe(200);
    expect(list.body.results).toEqual([]);

    // And cannot fetch B's record by id.
    const byId = await bearer(
      ctx.request(ctx.app).get(`/api/v1/account/${bRecord.body._id}`),
      minted.body.key
    );
    expect(byId.status).toBe(404);
  });
});
