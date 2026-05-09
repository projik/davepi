const { setupTestApp, registerUser } = require('./helpers');
const {
  validateAndCastParams,
  buildPipeline,
  assertSafePipeline,
  AggregationParamError,
  AggregationSafetyError,
  FORBIDDEN_STAGES,
  DEFAULT_RESULT_LIMIT,
} = require('../utils/aggregations');
const { createAggregationCache } = require('../utils/aggregationCache');

// Pure-function helpers don't need the live app, so they get their own
// describe block above the integration tests.
describe('aggregations: pure helpers', () => {
  describe('validateAndCastParams', () => {
    test('rejects unknown param types', () => {
      expect(() => validateAndCastParams({ x: { type: 'array' } }, {})).toThrow(
        AggregationParamError
      );
    });

    test('throws when a required param is missing', () => {
      expect(() =>
        validateAndCastParams({ from: { type: 'date', required: true } }, {})
      ).toThrow(/from is required/);
    });

    test('skips optional params silently', () => {
      const out = validateAndCastParams({ from: { type: 'date' } }, {});
      expect(out).toEqual({});
    });

    test('casts each scalar type', () => {
      const out = validateAndCastParams(
        {
          s: { type: 'string' },
          n: { type: 'number' },
          b: { type: 'boolean' },
          d: { type: 'date' },
        },
        { s: 7, n: '42', b: 'true', d: '2025-01-01' }
      );
      expect(out.s).toBe('7');
      expect(out.n).toBe(42);
      expect(out.b).toBe(true);
      expect(out.d instanceof Date).toBe(true);
    });

    test('rejects values that fail to cast', () => {
      expect(() =>
        validateAndCastParams({ n: { type: 'number' } }, { n: 'banana' })
      ).toThrow(/not a number/);
      expect(() =>
        validateAndCastParams({ d: { type: 'date' } }, { d: 'not-a-date' })
      ).toThrow(/not a date/);
      expect(() =>
        validateAndCastParams({ id: { type: 'objectId' } }, { id: 'xx' })
      ).toThrow(/not an ObjectId/);
    });
  });

  describe('assertSafePipeline', () => {
    test.each(Array.from(FORBIDDEN_STAGES))(
      'rejects %s by default',
      (op) => {
        expect(() => assertSafePipeline([{ [op]: {} }], {})).toThrow(
          AggregationSafetyError
        );
      }
    );

    test('unsafe: true opts the pipeline back in', () => {
      // Defense-in-depth: schemas can declare `unsafe: true` to allow
      // forbidden stages on a per-aggregation basis. Tenant isolation
      // is still enforced by the prepended $match.
      expect(() =>
        assertSafePipeline([{ $lookup: {} }], { unsafe: true })
      ).not.toThrow();
    });

    test('rejects forbidden ops nested inside other stages', () => {
      // A top-level-only check would let `$function` slip through
      // because the top-level key is `$project`, not `$function`.
      // The recursive walk catches it.
      expect(() =>
        assertSafePipeline(
          [{ $project: { x: { $function: { body: 'x', args: [], lang: 'js' } } } }],
          {}
        )
      ).toThrow(AggregationSafetyError);
    });

    test('rejects $lookup nested inside a $facet sub-pipeline', () => {
      expect(() =>
        assertSafePipeline(
          [
            {
              $facet: {
                joined: [
                  { $lookup: { from: 'user', localField: 'userId', foreignField: '_id', as: 'u' } },
                ],
              },
            },
          ],
          {}
        )
      ).toThrow(AggregationSafetyError);
    });
  });

  describe('buildPipeline', () => {
    test('prepends $match: { userId } and stringifies the userId', () => {
      const out = buildPipeline(
        { pipeline: [{ $count: 'n' }] },
        { userId: 12345, params: {} }
      );
      expect(out[0]).toEqual({ $match: { userId: '12345' } });
    });

    test('substitutes :name placeholders with cast params', () => {
      const out = buildPipeline(
        {
          pipeline: [
            { $match: { createdAt: { $gte: ':from', $lt: ':to' } } },
          ],
        },
        {
          userId: 'u1',
          params: { from: new Date('2025-01-01'), to: new Date('2025-12-31') },
        }
      );
      const matchStage = out[1].$match;
      expect(matchStage.createdAt.$gte).toEqual(new Date('2025-01-01'));
      expect(matchStage.createdAt.$lt).toEqual(new Date('2025-12-31'));
    });

    test('appends $limit when the pipeline does not declare one', () => {
      const out = buildPipeline(
        { pipeline: [{ $sort: { _id: 1 } }] },
        { userId: 'u1', params: {} }
      );
      expect(out[out.length - 1]).toEqual({ $limit: DEFAULT_RESULT_LIMIT });
    });

    test('respects an explicit maxResults', () => {
      const out = buildPipeline(
        { pipeline: [], maxResults: 5 },
        { userId: 'u1', params: {} }
      );
      expect(out[out.length - 1]).toEqual({ $limit: 5 });
    });

    test('does not double-limit when the pipeline already has $limit', () => {
      const out = buildPipeline(
        { pipeline: [{ $limit: 3 }] },
        { userId: 'u1', params: {} }
      );
      const limits = out.filter((s) => s && Object.prototype.hasOwnProperty.call(s, '$limit'));
      expect(limits).toHaveLength(1);
      expect(limits[0]).toEqual({ $limit: 3 });
    });

    test('rejects forbidden stages', () => {
      expect(() =>
        buildPipeline(
          { pipeline: [{ $out: 'sink' }] },
          { userId: 'u1', params: {} }
        )
      ).toThrow(AggregationSafetyError);
    });
  });

  describe('aggregation cache', () => {
    test('keys partition by user, resource, name, and params', () => {
      const cache = createAggregationCache();
      const a = cache.key({ resource: 'q', name: 'n', userId: 'u1', params: { x: 1 } });
      const b = cache.key({ resource: 'q', name: 'n', userId: 'u2', params: { x: 1 } });
      const c = cache.key({ resource: 'q', name: 'n', userId: 'u1', params: { x: 2 } });
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
    });

    test('returns undefined past TTL', async () => {
      const cache = createAggregationCache();
      cache.set('k', { rows: 1 }, 1);
      // 1 second TTL — wait just over that to exercise expiry.
      await new Promise((r) => setTimeout(r, 1100));
      expect(cache.get('k')).toBeUndefined();
    });

    test('evicts oldest entry when maxEntries is reached', () => {
      const cache = createAggregationCache({ maxEntries: 2 });
      cache.set('a', 1, 60);
      cache.set('b', 2, 60);
      cache.set('c', 3, 60); // 'a' should fall out
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
    });
  });
});

// Integration tests need a live app, real Mongo, and a live schema with
// aggregations declared. We register the schema dynamically (instead of
// editing a seed file) so the test suite stays self-contained.
describe('aggregations: REST + GraphQL integration', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  // The integration schema declares one aggregation per acceptance
  // criterion: a parameterised one (totalsBetween) for $match
  // substitution, an unparameterised one (countAll) for cache testing,
  // an `unsafe: true` one for opt-in lookup, and a small-limit one
  // (firstFew) so we can verify the implicit $limit cap.
  const orderSchema = {
    path: 'order',
    collection: 'order_test',
    version: 'v1',
    fields: [
      { name: 'userId', type: String, required: true },
      { name: 'amount', type: Number, required: true },
      { name: 'category', type: String },
    ],
    aggregations: [
      {
        name: 'totalsBetween',
        description: 'Sum amount between two dates',
        params: {
          minAmount: { type: 'number', required: true },
        },
        pipeline: [
          { $match: { amount: { $gte: ':minAmount' } } },
          { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        ],
      },
      {
        name: 'countAll',
        cache: { ttlSeconds: 60 },
        pipeline: [{ $count: 'n' }],
      },
      {
        name: 'firstFew',
        // Tiny maxResults so we can assert the implicit $limit applies.
        maxResults: 2,
        pipeline: [{ $sort: { amount: -1 } }],
      },
      {
        name: 'tryLookup',
        // Intentionally forbidden — the request must 400 even though
        // unsafe: true is NOT set.
        pipeline: [
          { $lookup: { from: 'user', localField: 'userId', foreignField: '_id', as: 'u' } },
        ],
      },
      {
        name: 'tryOut',
        pipeline: [{ $out: 'leaked' }],
      },
      {
        name: 'tryMerge',
        pipeline: [{ $merge: 'leaked' }],
      },
      {
        name: 'lookupOptedIn',
        unsafe: true,
        pipeline: [
          // No real cross-collection join needed for the test — empty
          // pipeline returns user-isolated rows; we just want to prove
          // unsafe: true bypasses the safety check at validation time.
          { $count: 'n' },
        ],
      },
    ],
  };

  let userA;
  let userB;

  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema(orderSchema);
    userA = await registerUser(ctx.request, ctx.app);
    userB = await registerUser(ctx.request, ctx.app);

    const seedFor = async (token, rows) => {
      for (const row of rows) {
        const r = await ctx
          .request(ctx.app)
          .post('/api/v1/order')
          .set('Authorization', `Bearer ${token}`)
          .send(row);
        if (r.status !== 201) {
          throw new Error(
            `seed failed: ${r.status} ${JSON.stringify(r.body)}`
          );
        }
      }
    };

    await seedFor(userA.token, [
      { amount: 10, category: 'a' },
      { amount: 20, category: 'a' },
      { amount: 30, category: 'b' },
    ]);
    await seedFor(userB.token, [
      { amount: 999, category: 'a' },
      { amount: 100, category: 'b' },
    ]);
  });

  afterAll(async () => {
    await ctx.app.locals.schemaLoader.unloadSchema('v1/order');
  });

  describe('REST', () => {
    test('requires authentication', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/countAll');
      expect(res.status).toBe(403);
    });

    test('returns user-isolated results: A sees only A rows', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/totalsBetween?minAmount=0')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(200);
      // Sum = 10 + 20 + 30 = 60. Critically, NOT 60 + 999 + 100.
      expect(res.body).toEqual([{ _id: null, total: 60, count: 3 }]);
    });

    test('returns user-isolated results: B sees only B rows', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/totalsBetween?minAmount=0')
        .set('Authorization', `Bearer ${userB.token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ _id: null, total: 1099, count: 2 }]);
    });

    test('substitutes :name placeholders from query params', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/totalsBetween?minAmount=25')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(200);
      // Only the $30 row qualifies for User A.
      expect(res.body).toEqual([{ _id: null, total: 30, count: 1 }]);
    });

    test('rejects missing required params with 400', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/totalsBetween')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toMatch(/minAmount is required/);
    });

    test('rejects un-castable param values with 400', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/totalsBetween?minAmount=banana')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not a number/);
    });

    test('rejects $lookup, $out, $merge with 400 (no opt-in)', async () => {
      for (const name of ['tryLookup', 'tryOut', 'tryMerge']) {
        const res = await ctx
          .request(ctx.app)
          .get(`/api/v1/order/aggregations/${name}`)
          .set('Authorization', `Bearer ${userA.token}`);
        expect(res.status).toBe(400);
        expect(res.body.error.message).toMatch(/forbidden/);
      }
    });

    test('unsafe: true bypasses the forbidden-stage check', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/lookupOptedIn')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ n: 3 }]);
    });

    test('caches results across calls (X-davepi-Aggregation-Cache)', async () => {
      const miss = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/countAll')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(miss.status).toBe(200);
      expect(miss.body).toEqual([{ n: 3 }]);
      expect(miss.headers['x-davepi-aggregation-cache']).toBe('miss');

      const hit = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/countAll')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(hit.status).toBe(200);
      expect(hit.body).toEqual([{ n: 3 }]);
      expect(hit.headers['x-davepi-aggregation-cache']).toBe('hit');
    });

    test('cache does not bleed across users', async () => {
      // User A's cached countAll is 3; B issuing the same query must
      // not return 3 — it must miss for B's tenant and return 2.
      const aHit = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/countAll')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(aHit.body).toEqual([{ n: 3 }]);

      const bMiss = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/countAll')
        .set('Authorization', `Bearer ${userB.token}`);
      expect(bMiss.status).toBe(200);
      expect(bMiss.body).toEqual([{ n: 2 }]);
      expect(bMiss.headers['x-davepi-aggregation-cache']).toBe('miss');
    });

    test('implicit $limit caps results', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/order/aggregations/firstFew')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(200);
      // User A has 3 docs; maxResults: 2 means we get only the top 2.
      expect(res.body).toHaveLength(2);
      expect(res.body[0].amount).toBe(30);
      expect(res.body[1].amount).toBe(20);
    });

    test('Swagger spec exposes each aggregation with declared params', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api-docs/swagger.json');
      expect(res.status).toBe(200);
      const path = res.body.paths['/api/v1/order/aggregations/totalsBetween'];
      expect(path).toBeDefined();
      expect(path.get.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'minAmount',
            in: 'query',
            type: 'number',
            required: true,
          }),
        ])
      );
    });
  });

  describe('GraphQL', () => {
    const gql = (token, query, variables) => {
      const r = ctx
        .request(ctx.app)
        .post('/graphql/')
        .send({ query, variables });
      if (token) r.set('Authorization', `Bearer ${token}`);
      return r;
    };

    test('top-level query is generated per aggregation', async () => {
      const res = await gql(
        userA.token,
        'query Q($minAmount: Float!) { orderTotalsBetween(minAmount: $minAmount) }',
        { minAmount: 0 }
      );
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.orderTotalsBetween).toEqual([
        { _id: null, total: 60, count: 3 },
      ]);
    });

    test('rejects unauthenticated callers', async () => {
      const res = await gql(
        null,
        'query { orderCountAll }'
      );
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    });

    test('honors user isolation', async () => {
      const a = await gql(userA.token, 'query { orderCountAll }');
      const b = await gql(userB.token, 'query { orderCountAll }');
      expect(a.body.data.orderCountAll).toEqual([{ n: 3 }]);
      expect(b.body.data.orderCountAll).toEqual([{ n: 2 }]);
    });

    test('rejects $out at GraphQL layer too', async () => {
      const res = await gql(userA.token, 'query { orderTryOut }');
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/forbidden/);
    });
  });
});
