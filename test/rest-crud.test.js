const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

describe('REST CRUD: auth middleware', () => {
  test('protected route without Authorization header returns 403', async () => {
    const res = await ctx.request(ctx.app).get('/api/v1/account');
    expect(res.status).toBe(403);
  });

  test('protected route with malformed token returns 401', async () => {
    const res = await ctx
      .request(ctx.app)
      .get('/api/v1/account')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('REST CRUD: pagination', () => {
  let token;

  beforeEach(async () => {
    const user = await registerUser(ctx.request, ctx.app);
    token = user.token;

    // PAGE_SIZE is 20 in the test env; create 25 to span 2 pages.
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    for (let i = 0; i < 25; i++) {
      await auth(
        ctx.request(ctx.app).post('/api/v1/account')
      ).send({ accountName: `acct-${i.toString().padStart(2, '0')}` });
    }
  });

  test('first page returns perPage records and a nextPage pointer', async () => {
    const res = await ctx
      .request(ctx.app)
      .get('/api/v1/account?__page=1&__sort=accountName:asc')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(20);
    expect(res.body.totalResults).toBe(25);
    expect(res.body.page).toBe(1);
    expect(res.body.perPage).toBe(20);
    expect(res.body.totalPages).toBe(2);
    expect(res.body.nextPage).toBe(2);
    expect(res.body.prevPage).toBeUndefined();
    expect(res.body.results[0].accountName).toBe('acct-00');
  });

  test('second page returns the remaining records and a prevPage pointer', async () => {
    const res = await ctx
      .request(ctx.app)
      .get('/api/v1/account?__page=2&__sort=accountName:asc')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(5);
    expect(res.body.page).toBe(2);
    expect(res.body.prevPage).toBe(1);
    expect(res.body.nextPage).toBeUndefined();
    expect(res.body.results[0].accountName).toBe('acct-20');
  });
});

describe('REST CRUD: querystring filters', () => {
  let token;

  beforeEach(async () => {
    const user = await registerUser(ctx.request, ctx.app);
    token = user.token;
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);

    await auth(ctx.request(ctx.app).post('/api/v1/account')).send({
      accountName: 'Acme',
      description: 'first',
    });
    await auth(ctx.request(ctx.app).post('/api/v1/account')).send({
      accountName: 'Globex',
      description: 'second',
    });
    await auth(ctx.request(ctx.app).post('/api/v1/account')).send({
      accountName: 'Initech',
      description: 'third',
    });
  });

  test('exact-match filter via mongo-querystring', async () => {
    const res = await ctx
      .request(ctx.app)
      .get('/api/v1/account?accountName=Globex')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(1);
    expect(res.body.results[0].accountName).toBe('Globex');
  });

  test('regex filter via mongo-querystring (leading ^)', async () => {
    // mongo-querystring 4.1.1 auto-detects regex via leading-character
    // heuristics; the value "^I" becomes { $regex: "^I", $options: "i" }.
    const res = await ctx
      .request(ctx.app)
      .get('/api/v1/account?accountName=%5EI')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(1);
    expect(res.body.results[0].accountName).toBe('Initech');
  });

  test('underscore-prefixed params (__page, __sort) are not used as filters', async () => {
    const res = await ctx
      .request(ctx.app)
      .get('/api/v1/account?__page=1&__sort=accountName:asc')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(3); // all three, not zero
  });
});

describe('REST CRUD: cross-user isolation', () => {
  let aToken;
  let bToken;
  let aRecordId;

  beforeEach(async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);
    aToken = a.token;
    bToken = b.token;

    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ accountName: 'A-private' });
    expect(created.status).toBe(201);
    aRecordId = created.body._id;
  });

  test('User B cannot list User A records', async () => {
    const res = await ctx
      .request(ctx.app)
      .get('/api/v1/account')
      .set('Authorization', `Bearer ${bToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(0);
    expect(res.body.results).toEqual([]);
  });

  test('User B cannot fetch User A record by id (404)', async () => {
    const res = await ctx
      .request(ctx.app)
      .get(`/api/v1/account/${aRecordId}`)
      .set('Authorization', `Bearer ${bToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('User B cannot delete User A record (404)', async () => {
    const res = await ctx
      .request(ctx.app)
      .delete(`/api/v1/account/${aRecordId}`)
      .set('Authorization', `Bearer ${bToken}`);
    expect(res.status).toBe(404);

    // record still exists for User A
    const stillThere = await ctx
      .request(ctx.app)
      .get(`/api/v1/account/${aRecordId}`)
      .set('Authorization', `Bearer ${aToken}`);
    expect(stillThere.status).toBe(200);
  });

  test('User B cannot update User A record (404)', async () => {
    const res = await ctx
      .request(ctx.app)
      .put(`/api/v1/account/${aRecordId}`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ accountName: 'hijacked' });
    expect(res.status).toBe(404);

    const original = await ctx
      .request(ctx.app)
      .get(`/api/v1/account/${aRecordId}`)
      .set('Authorization', `Bearer ${aToken}`);
    expect(original.body.accountName).toBe('A-private');
  });
});
