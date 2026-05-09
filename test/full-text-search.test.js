const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

const articleSchema = {
  path: 'article',
  collection: 'articles',
  version: 'v1',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'title', type: String, required: true, searchable: true, searchWeight: 10 },
    { name: 'body', type: String, searchable: true },
    { name: 'tags', type: [String], searchable: true },
    { name: 'authorId', type: String, required: true },
  ],
};

const post = (path, body, token) => {
  const r = ctx.request(ctx.app).post(path).send(body);
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r;
};
const get = (path, token) => {
  const r = ctx.request(ctx.app).get(path);
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r;
};
const gql = (token, query, variables) => {
  const r = ctx.request(ctx.app).post('/graphql/').send({ query, variables });
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r;
};

describe('Full-text search', () => {
  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema(articleSchema);
  });

  describe('text index', () => {
    test('a compound text index is created across every searchable field', async () => {
      const Model = require('mongoose').models.articles;
      const indexes = await Model.collection.indexes();
      const text = indexes.find((idx) => idx.name === 'article_text');
      expect(text).toBeDefined();
      // weights reflect the title's higher searchWeight.
      expect(text.weights.title).toBe(10);
      expect(text.weights.body).toBe(1);
      expect(text.weights.tags).toBe(1);
    });

    test('a schema with no searchable fields does not get a text index', async () => {
      // The seed `account` schema has no `searchable: true` — verify
      // we didn't accidentally create one for it.
      const Model = require('mongoose').models.account;
      const indexes = await Model.collection.indexes();
      expect(indexes.find((i) => i.name === 'account_text')).toBeUndefined();
    });
  });

  describe('REST __q', () => {
    let token;
    beforeEach(async () => {
      const u = await registerUser(ctx.request, ctx.app);
      token = u.token;
      await post('/api/v1/article', { title: 'Quantum mechanics primer', body: 'wavefunctions and operators', tags: ['physics'], authorId: '1' }, token);
      await post('/api/v1/article', { title: 'Cooking with sous vide', body: 'temperatures matter', tags: ['food'], authorId: '1' }, token);
      await post('/api/v1/article', { title: 'Dog training basics', body: 'positive reinforcement works', tags: ['pets'], authorId: '1' }, token);
      await post('/api/v1/article', { title: 'Quantum entanglement', body: 'spookiness at a distance', tags: ['physics', 'quantum'], authorId: '1' }, token);
    });

    test('?__q=quantum returns only matching documents', async () => {
      const r = await get('/api/v1/article?__q=quantum', token);
      expect(r.status).toBe(200);
      expect(r.body.totalResults).toBe(2);
      const titles = r.body.results.map((d) => d.title);
      expect(titles).toEqual(expect.arrayContaining(['Quantum mechanics primer', 'Quantum entanglement']));
    });

    test('?__q=physics matches via the tag array', async () => {
      const r = await get('/api/v1/article?__q=physics', token);
      expect(r.body.totalResults).toBe(2);
    });

    test('?__q with no matches returns an empty list (no 500)', async () => {
      const r = await get('/api/v1/article?__q=lksjdflksdjf', token);
      expect(r.status).toBe(200);
      expect(r.body.totalResults).toBe(0);
    });

    test('?__sort=score orders by text relevance', async () => {
      const r = await get('/api/v1/article?__q=quantum entanglement&__sort=score', token);
      expect(r.status).toBe(200);
      expect(r.body.results.length).toBeGreaterThanOrEqual(1);
      // The article that contains BOTH terms should rank ahead of
      // the one that has only "quantum".
      expect(r.body.results[0].title).toBe('Quantum entanglement');
    });

    test('combining __q with regular filters', async () => {
      const r = await get('/api/v1/article?__q=quantum&authorId=1', token);
      expect(r.body.totalResults).toBe(2);
    });

    test('cross-user isolation: User B cannot full-text-search User A records', async () => {
      const b = await registerUser(ctx.request, ctx.app);
      const r = await get('/api/v1/article?__q=quantum', b.token);
      expect(r.body.totalResults).toBe(0);
    });

    test('schemas without searchable fields ignore __q (no text index error)', async () => {
      // account has no text index; __q should fall through to the
      // querystring filter path without erroring.
      const u = await registerUser(ctx.request, ctx.app);
      await post('/api/v1/account', { accountName: 'A' }, u.token);
      const r = await get('/api/v1/account?__q=anything', u.token);
      expect(r.status).toBe(200);
      // __q didn't filter anything in or out — the user's own record
      // is still listed.
      expect(r.body.totalResults).toBe(1);
    });

    test('non-searchable schema + __q + __sort=score does NOT 500 from mismatched textScore', async () => {
      // Without the score-sort gate, the handler would project
      // { $meta: 'textScore' } without $text in the query and Mongo
      // rejects the find. Should fall through to no sort at all.
      const u = await registerUser(ctx.request, ctx.app);
      await post('/api/v1/account', { accountName: 'A' }, u.token);
      const r = await get('/api/v1/account?__q=foo&__sort=score', u.token);
      expect(r.status).toBe(200);
      expect(r.body.totalResults).toBe(1);
    });
  });

  describe('GraphQL search', () => {
    let token;
    beforeEach(async () => {
      const u = await registerUser(ctx.request, ctx.app);
      token = u.token;
      await post('/api/v1/article', { title: 'Quantum mechanics', body: 'a', tags: ['physics'], authorId: '1' }, token);
      await post('/api/v1/article', { title: 'Cooking', body: 'b', tags: ['food'], authorId: '1' }, token);
    });

    test('articleMany(filter: { search: "quantum" }) returns only matches', async () => {
      // graphql-compose-mongoose puts `search` at the top-level args
      // of the resolver because we declared it via `addArgs`. It's
      // NOT inside the `filter` arg; it's a sibling.
      const res = await gql(
        token,
        'query { articleMany(search: "quantum") { _id title } }'
      );
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.articleMany).toHaveLength(1);
      expect(res.body.data.articleMany[0].title).toBe('Quantum mechanics');
    });

    test('articleCount(search: "quantum") returns the matching count', async () => {
      const res = await gql(token, 'query { articleCount(search: "quantum") }');
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.articleCount).toBe(1);
    });

    test('search arg is NOT exposed on schemas without searchable fields', async () => {
      const res = await gql(
        token,
        'query { accountMany(search: "x") { _id } }'
      );
      // GraphQL parse-time error: unknown argument.
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });
  });

  describe('Swagger', () => {
    test('GET /api/v1/article documents __q as a query parameter', async () => {
      const r = await get('/api-docs/swagger.json');
      const params = r.body.paths['/api/v1/article'].get.parameters;
      const qParam = params.find((p) => p.name === '__q');
      expect(qParam).toBeDefined();
      expect(qParam.in).toBe('query');
      expect(qParam.description).toMatch(/full-text/i);
    });

    test('schemas without searchable fields do NOT advertise __q', async () => {
      const r = await get('/api-docs/swagger.json');
      const params = r.body.paths['/api/v1/account'].get.parameters;
      expect(params.find((p) => p.name === '__q')).toBeUndefined();
    });
  });
});
