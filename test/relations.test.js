const { setupTestApp, registerUser } = require('./helpers');
const {
  normalizeRelations,
  parseIncludes,
} = require('../utils/relations');

describe('relations: pure helpers', () => {
  describe('normalizeRelations', () => {
    test('compiles explicit hasMany / hasOne / belongsTo entries', () => {
      const out = normalizeRelations({
        relations: {
          tasks: { hasMany: 'task', foreignKey: 'acctId' },
          owner: { belongsTo: 'user', localKey: 'userId' },
          primary: {
            hasOne: 'contact',
            foreignKey: 'acctId',
            where: { isPrimary: true },
          },
        },
      });
      expect(out.tasks).toMatchObject({
        kind: 'hasMany',
        target: 'task',
        foreignKey: 'acctId',
      });
      expect(out.owner).toMatchObject({
        kind: 'belongsTo',
        target: 'user',
        localKey: 'userId',
      });
      expect(out.primary).toMatchObject({
        kind: 'hasOne',
        target: 'contact',
        foreignKey: 'acctId',
        where: { isPrimary: true },
      });
    });

    test('fk shorthand resolves as foreignKey for hasMany/hasOne', () => {
      const out = normalizeRelations({
        relations: {
          tasks: { hasMany: 'task', fk: 'acctId' },
          primary: { hasOne: 'contact', fk: 'acctId' },
        },
      });
      expect(out.tasks.foreignKey).toBe('acctId');
      expect(out.primary.foreignKey).toBe('acctId');
    });

    test('fk shorthand resolves as localKey for belongsTo', () => {
      const out = normalizeRelations({
        relations: { owner: { belongsTo: 'user', fk: 'ownerId' } },
      });
      expect(out.owner.localKey).toBe('ownerId');
    });

    test('belongsTo localKey defaults to `${name}Id`', () => {
      const out = normalizeRelations({
        relations: { author: { belongsTo: 'user' } },
      });
      expect(out.author.localKey).toBe('authorId');
    });

    test('field.reference: synthesises a belongsTo and flags fromShorthand', () => {
      const out = normalizeRelations({
        fields: [{ name: 'acctId', type: String, reference: 'account' }],
      });
      expect(out.acctId).toMatchObject({
        kind: 'belongsTo',
        target: 'account',
        localKey: 'acctId',
        fromShorthand: true,
      });
    });

    test('explicit relations win over field.reference shorthand', () => {
      const out = normalizeRelations({
        fields: [{ name: 'acctId', type: String, reference: 'account' }],
        relations: { acctId: { belongsTo: 'account', localKey: 'acctId' } },
      });
      expect(out.acctId.fromShorthand).toBeUndefined();
    });

    test('shorthand skips when an explicit belongsTo already uses the same localKey', () => {
      // A schema that pairs `field.reference` (for UI consumers like the
      // RelationPicker) with an explicit `relations.<name>.belongsTo`
      // targeting the same local key — like the seed CRM `quote.contactId`
      // — should produce exactly one belongsTo, not two. Without the
      // dedup, REST `__include` would advertise both names, and the MCP
      // server would register two relation-navigation tools that join
      // the same two rows.
      const out = normalizeRelations({
        fields: [{ name: 'contactId', type: String, reference: 'contact' }],
        relations: { contact: { belongsTo: 'contact', localKey: 'contactId' } },
      });
      expect(Object.keys(out).sort()).toEqual(['contact']);
      expect(out.contact).toMatchObject({
        kind: 'belongsTo',
        target: 'contact',
        localKey: 'contactId',
      });
      expect(out.contact.fromShorthand).toBeUndefined();
      expect(out.contactId).toBeUndefined();
    });

    test('shorthand still fires when explicit belongsTo points at a different localKey', () => {
      // Defence: dedup must not over-eagerly drop a shorthand whose
      // localKey is genuinely different from any declared one.
      const out = normalizeRelations({
        fields: [
          { name: 'authorId', type: String, reference: 'user' },
          { name: 'editorId', type: String, reference: 'user' },
        ],
        relations: {
          primaryAuthor: { belongsTo: 'user', localKey: 'authorId' },
        },
      });
      expect(out.primaryAuthor.localKey).toBe('authorId');
      // authorId's shorthand suppressed (localKey already covered).
      expect(out.authorId).toBeUndefined();
      // editorId's shorthand survives — distinct localKey.
      expect(out.editorId).toMatchObject({
        kind: 'belongsTo',
        target: 'user',
        localKey: 'editorId',
        fromShorthand: true,
      });
    });
  });

  describe('parseIncludes', () => {
    const normalized = {
      tasks: { kind: 'hasMany', target: 'task' },
      owner: { kind: 'belongsTo', target: 'user' },
    };

    test('returns [] when __include is missing', () => {
      expect(parseIncludes(undefined, normalized)).toEqual([]);
      expect(parseIncludes('', normalized)).toEqual([]);
    });

    test('splits a CSV', () => {
      expect(parseIncludes('tasks,owner', normalized)).toEqual(['tasks', 'owner']);
    });

    test('trims whitespace and skips empties', () => {
      expect(parseIncludes(' tasks , , owner ', normalized)).toEqual(['tasks', 'owner']);
    });

    test('throws on unknown relation names (with allowed list in message)', () => {
      expect(() => parseIncludes('tasks,bogus', normalized)).toThrow(
        /Unknown __include relation\(s\): bogus.*Allowed: tasks, owner/
      );
    });
  });
});

describe('relations: REST + GraphQL integration', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  // Three schemas wired together: account hasMany contacts, contact
  // belongsTo account. The contact also carries `isPrimary: true` to
  // exercise hasOne with a `where` clause.
  const accountSchema = {
    path: 'rel_account',
    collection: 'rel_account',
    version: 'v1',
    fields: [
      { name: 'userId', type: String, required: true },
      { name: 'name', type: String, required: true },
    ],
    relations: {
      contacts: { hasMany: 'rel_contact', foreignKey: 'acctId' },
      primaryContact: {
        hasOne: 'rel_contact',
        foreignKey: 'acctId',
        where: { isPrimary: true },
      },
    },
  };

  const contactSchema = {
    path: 'rel_contact',
    collection: 'rel_contact',
    version: 'v1',
    fields: [
      { name: 'userId', type: String, required: true },
      { name: 'acctId', type: String, required: true },
      { name: 'name', type: String, required: true },
      { name: 'isPrimary', type: Boolean, default: false },
    ],
    relations: {
      account: { belongsTo: 'rel_account', localKey: 'acctId' },
    },
  };

  let userA;
  let userB;
  let aAccountId;
  let aOtherAccountId;
  let bAccountId;

  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema(accountSchema, { deferGraphqlRebuild: true });
    await ctx.app.locals.schemaLoader.loadSchema(contactSchema);

    userA = await registerUser(ctx.request, ctx.app);
    userB = await registerUser(ctx.request, ctx.app);

    const post = async (token, path, body) => {
      const r = await ctx
        .request(ctx.app)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      if (r.status !== 201) {
        throw new Error(`seed failed: ${path} ${r.status} ${JSON.stringify(r.body)}`);
      }
      return r.body;
    };

    const aAcct = await post(userA.token, '/api/v1/rel_account', { name: 'A-acct' });
    aAccountId = aAcct._id;
    const aAcct2 = await post(userA.token, '/api/v1/rel_account', { name: 'A-acct2' });
    aOtherAccountId = aAcct2._id;
    const bAcct = await post(userB.token, '/api/v1/rel_account', { name: 'B-acct' });
    bAccountId = bAcct._id;

    // A's contacts: 2 against aAccountId (one primary), 1 against aOtherAccountId
    await post(userA.token, '/api/v1/rel_contact', {
      acctId: aAccountId,
      name: 'A-c1',
      isPrimary: true,
    });
    await post(userA.token, '/api/v1/rel_contact', {
      acctId: aAccountId,
      name: 'A-c2',
    });
    await post(userA.token, '/api/v1/rel_contact', {
      acctId: aOtherAccountId,
      name: 'A-c3',
    });

    // B has its own contact under its own account.
    await post(userB.token, '/api/v1/rel_contact', {
      acctId: bAccountId,
      name: 'B-c1',
    });
  });

  afterAll(async () => {
    await ctx.app.locals.schemaLoader.unloadSchema('v1/rel_contact');
    await ctx.app.locals.schemaLoader.unloadSchema('v1/rel_account');
  });

  describe('REST __include', () => {
    test('belongsTo: contact?__include=account populates the account record', async () => {
      const list = await ctx
        .request(ctx.app)
        .get('/api/v1/rel_contact?__include=account')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(list.status).toBe(200);
      expect(list.body.results).toHaveLength(3);
      for (const c of list.body.results) {
        expect(c.account).toBeTruthy();
        expect(c.account._id).toBe(c.acctId);
      }
    });

    test('hasMany: account?__include=contacts populates child arrays in a single round-trip', async () => {
      // Spy on Model.find via mongoose to count calls.
      const mongoose = require('mongoose');
      const ContactModel = mongoose.models.rel_contact;
      const originalFind = ContactModel.find.bind(ContactModel);
      let findCalls = 0;
      ContactModel.find = (...args) => {
        findCalls += 1;
        return originalFind(...args);
      };
      try {
        const res = await ctx
          .request(ctx.app)
          .get('/api/v1/rel_account?__include=contacts')
          .set('Authorization', `Bearer ${userA.token}`);
        expect(res.status).toBe(200);
        // Two parent accounts for User A; the include layer must
        // batch into ONE find against rel_contact, not N.
        const accounts = res.body.results;
        expect(accounts).toHaveLength(2);
        const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
        expect(byName['A-acct'].contacts).toHaveLength(2);
        expect(byName['A-acct2'].contacts).toHaveLength(1);
        expect(findCalls).toBe(1);
      } finally {
        ContactModel.find = originalFind;
      }
    });

    test('hasOne with where: primaryContact picks only the matching child', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/rel_account?__include=primaryContact')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(200);
      const byName = Object.fromEntries(res.body.results.map((a) => [a.name, a]));
      expect(byName['A-acct'].primaryContact).toBeTruthy();
      expect(byName['A-acct'].primaryContact.name).toBe('A-c1');
      expect(byName['A-acct2'].primaryContact).toBeNull();
    });

    test('GET /:id with __include populates correctly', async () => {
      const res = await ctx
        .request(ctx.app)
        .get(`/api/v1/rel_account/${aAccountId}?__include=contacts`)
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.contacts).toHaveLength(2);
      expect(res.body.contacts.map((c) => c.name).sort()).toEqual(['A-c1', 'A-c2']);
    });

    test('cross-tenant isolation: User B cannot see User A children even via __include', async () => {
      // We seeded a contact under aAccountId for User A. If User B
      // somehow guesses the parent _id, the parent fetch returns 404
      // — but the more subtle attack is "borrow" a parent from B's
      // own collection that happens to share an _id field. The
      // include-layer userId re-injection blocks that.
      const res = await ctx
        .request(ctx.app)
        .get(`/api/v1/rel_account/${aAccountId}?__include=contacts`)
        .set('Authorization', `Bearer ${userB.token}`);
      expect(res.status).toBe(404);
    });

    test('relation queries re-apply userId so a parent borrow cannot leak children', async () => {
      // Direct sanity check on the include layer itself: User B's
      // list of accounts populated with contacts must NOT include
      // any of User A's contacts.
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/rel_account?__include=contacts')
        .set('Authorization', `Bearer ${userB.token}`);
      expect(res.status).toBe(200);
      const allChildren = res.body.results.flatMap((a) => a.contacts || []);
      for (const child of allChildren) {
        expect(child.userId).toBe(userB._id);
      }
    });

    test('unknown __include returns 400 with the allowed list', async () => {
      const res = await ctx
        .request(ctx.app)
        .get('/api/v1/rel_account?__include=tasks,contacts')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toMatch(/Unknown __include/);
      expect(res.body.error.message).toMatch(/contacts/); // allowed list mentioned
    });

    test('omitting __include returns the original document with no relation keys', async () => {
      const res = await ctx
        .request(ctx.app)
        .get(`/api/v1/rel_account/${aAccountId}`)
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.contacts).toBeUndefined();
      expect(res.body.primaryContact).toBeUndefined();
    });

    test('hasMany still groups correctly when the foreignKey is read-ACL restricted on the child', async () => {
      // Regression: projecting children through ACL before grouping
      // would strip the foreignKey from each child and break the
      // bucket. Force that condition by mutating the loaded child
      // schema to put `acl.read` on `acctId` for a role User A
      // doesn't have, then verify the include still groups.
      const childEntry = ctx.app.locals.schemaLoader.getEntry('v1/rel_contact');
      const acctIdField = childEntry.schema.fields.find((f) => f.name === 'acctId');
      const originalAcl = acctIdField.acl;
      acctIdField.acl = { read: ['admin'] }; // userA only has 'user'
      try {
        const res = await ctx
          .request(ctx.app)
          .get('/api/v1/rel_account?__include=contacts')
          .set('Authorization', `Bearer ${userA.token}`);
        expect(res.status).toBe(200);
        const byName = Object.fromEntries(res.body.results.map((a) => [a.name, a]));
        // Buckets are still correctly populated...
        expect(byName['A-acct'].contacts).toHaveLength(2);
        expect(byName['A-acct2'].contacts).toHaveLength(1);
        // ...and the ACL still hides acctId from the projected
        // children (otherwise we'd be leaking the field).
        for (const c of byName['A-acct'].contacts) {
          expect(c.acctId).toBeUndefined();
        }
      } finally {
        acctIdField.acl = originalAcl;
      }
    });

    test('Swagger documents __include per resource with the allowed names', async () => {
      const swagger = await ctx
        .request(ctx.app)
        .get('/api-docs/swagger.json');
      const listGet = swagger.body.paths['/api/v1/rel_account'].get;
      const includeParam = listGet.parameters.find((p) => p.name === '__include');
      expect(includeParam).toBeDefined();
      expect(includeParam.description).toMatch(/contacts/);
      expect(includeParam.description).toMatch(/primaryContact/);

      const itemGet = swagger.body.paths['/api/v1/rel_account/{id}'].get;
      const itemIncludeParam = itemGet.parameters.find((p) => p.name === '__include');
      expect(itemIncludeParam).toBeDefined();
    });
  });

  describe('GraphQL relation traversal', () => {
    const gql = (token, query, variables) => {
      const r = ctx
        .request(ctx.app)
        .post('/graphql/')
        .send({ query, variables });
      if (token) r.set('Authorization', `Bearer ${token}`);
      return r;
    };

    test('belongsTo: query a contact and traverse to its account', async () => {
      const res = await gql(
        userA.token,
        `query { rel_contactMany { _id name acctId account { _id name } } }`
      );
      expect(res.body.errors).toBeUndefined();
      const rows = res.body.data.rel_contactMany;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.account).toBeTruthy();
        expect(row.account._id).toBe(row.acctId);
      }
    });

    test('hasMany: query an account and traverse to its contacts', async () => {
      const res = await gql(
        userA.token,
        `query { rel_accountMany { _id name contacts { _id name acctId } } }`
      );
      expect(res.body.errors).toBeUndefined();
      const rows = res.body.data.rel_accountMany;
      expect(rows).toHaveLength(2);
      const byName = Object.fromEntries(rows.map((a) => [a.name, a]));
      expect(byName['A-acct'].contacts).toHaveLength(2);
      expect(byName['A-acct2'].contacts).toHaveLength(1);
    });

    test('GraphQL relation enforces tenant isolation', async () => {
      // User B should see only their own account, and that account's
      // contacts should be only B's own contacts (not A's).
      const res = await gql(
        userB.token,
        `query { rel_accountMany { _id name contacts { _id name userId } } }`
      );
      expect(res.body.errors).toBeUndefined();
      const rows = res.body.data.rel_accountMany;
      expect(rows).toHaveLength(1);
      for (const child of rows[0].contacts) {
        expect(child.userId).toBe(userB._id);
      }
    });

    test('hasOne with where: primaryContact picks only the matching child', async () => {
      const res = await gql(
        userA.token,
        `query { rel_accountMany { name primaryContact { name isPrimary } } }`
      );
      expect(res.body.errors).toBeUndefined();
      const byName = Object.fromEntries(res.body.data.rel_accountMany.map((a) => [a.name, a]));
      expect(byName['A-acct'].primaryContact).toBeTruthy();
      expect(byName['A-acct'].primaryContact.isPrimary).toBe(true);
      expect(byName['A-acct2'].primaryContact).toBeNull();
    });
  });
});
