/**
 * Integration test for davepi-plugin-audit: load it through the real
 * pluginLoader, against a live schema + bus + Mongo, and confirm that
 * a REST POST + PUT + DELETE on a tenant resource produces three
 * audit rows with the right before / after / diff.
 *
 * This is the proof that the plugin "just works" when listed in a
 * consumer's `davepi.plugins` array — the package's own unit tests
 * mock the bus and the Mongo model; this one drives the bus from
 * real HTTP requests and reads back from the `audit` collection
 * through the standard `GET /api/v1/audit` surface.
 *
 * `loadPlugins` is called once in `beforeAll` because each call adds
 * a bus listener and there's no public `unsubscribe` API — running it
 * per-test would fan out events to every previous listener and
 * inflate the per-test audit-row count. One subscriber, multiple
 * test scenarios, separate resource schemas per case.
 */

const path = require('path');
const { setupTestApp, registerUser } = require('./helpers');
const User = require('../model/user');

const ctx = setupTestApp();

describe('davepi-plugin-audit — end-to-end via pluginLoader', () => {
  beforeAll(async () => {
    const { loadPlugins } = require('../utils/pluginLoader');
    const { bus } = require('../utils/events');
    const auditModulePath = path.resolve(
      __dirname,
      '..',
      'packages',
      'davepi-plugin-audit'
    );
    const { createPlugin } = require(auditModulePath);

    const pluginInstance = createPlugin({
      env: { AUDIT_RETENTION_DAYS: '0' }, // disable TTL for the test
    });

    await loadPlugins({
      plugins: [pluginInstance],
      app: ctx.app,
      schemaLoader: ctx.app.locals.schemaLoader,
      bus,
      appName: 'integration-test-app',
    });
  });

  test('REST POST + PUT + DELETE produces three audit rows with correct before/after/diff', async () => {
    // A tenant resource the plugin will audit. Soft-delete is left on
    // (the framework default) so `DELETE /:id` emits a single
    // `<path>.deleted` event with before/after both populated — the
    // exact shape an audit reader expects for a soft-deleted row.
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'plugin_audit_target',
      collection: 'plugin_audit_target',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
        { name: 'amount', type: Number },
      ],
    });

    const user = await registerUser(ctx.request, ctx.app);

    // POST
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/plugin_audit_target')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'first', amount: 100 });
    expect(created.status).toBe(201);
    const id = created.body._id;

    // PUT
    const updated = await ctx
      .request(ctx.app)
      .put(`/api/v1/plugin_audit_target/${id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ amount: 250 });
    expect(updated.status).toBe(200);

    // DELETE
    const deleted = await ctx
      .request(ctx.app)
      .delete(`/api/v1/plugin_audit_target/${id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(deleted.status).toBe(200);

    // Let the bus listener flush.
    await new Promise((r) => setImmediate(r));

    // Read back through the standard REST surface. The caller is the
    // owner of the actions, so the userId scope returns their rows
    // without needing the admin bypass.
    const list = await ctx
      .request(ctx.app)
      .get('/api/v1/audit?resource=plugin_audit_target&__sort=at:asc')
      .set('Authorization', `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    const rows = list.body.results.filter(
      (r) => r.resource === 'plugin_audit_target' && r.resourceId === id
    );
    expect(rows).toHaveLength(3);

    // We assert on shape per action, not on list position (same-
    // millisecond ties make ordering brittle).
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(Object.keys(byAction).sort()).toEqual(['created', 'deleted', 'updated']);

    // --- created row ---
    expect(byAction.created.before).toBeNull();
    expect(byAction.created.after.title).toBe('first');
    expect(byAction.created.after.amount).toBe(100);
    expect(byAction.created.userId).toBe(String(user._id));
    // diff is a JSON-Patch (RFC 6902) — at least one `add` op per top-
    // level scalar field. We don't pin the exact op count because the
    // framework stamps additional fields (accountId, timestamps,
    // _id, deletedAt) that the plugin captures verbatim.
    const titleAdd = byAction.created.diff.find(
      (op) => op.op === 'add' && op.path === '/title'
    );
    expect(titleAdd).toBeDefined();
    expect(titleAdd.value).toBe('first');

    // --- updated row ---
    expect(byAction.updated.before.amount).toBe(100);
    expect(byAction.updated.after.amount).toBe(250);
    const amountReplace = byAction.updated.diff.find(
      (op) => op.path === '/amount'
    );
    expect(amountReplace).toBeDefined();
    expect(amountReplace.op).toBe('replace');
    expect(amountReplace.value).toBe(250);
    // RFC 6902 round-trip applicability — applying the audit row's
    // `diff` to its `before` snapshot must reconstruct its `after`.
    // The plugin's own unit tests cover this directly against the
    // in-package `compare`; here we run it on the end-to-end shape
    // landed by a real REST PUT. `fast-json-patch` is the framework's
    // devDep so it resolves from the root node_modules — the same
    // copy the plugin walks up to find at runtime.
    const jsonpatch = require('fast-json-patch');
    const reconstructed = jsonpatch.applyPatch(
      JSON.parse(JSON.stringify(byAction.updated.before)),
      JSON.parse(JSON.stringify(byAction.updated.diff))
    ).newDocument;
    expect(reconstructed).toEqual(byAction.updated.after);

    // --- deleted row ---
    // Soft-delete: before has deletedAt: null, after has deletedAt set.
    expect(byAction.deleted.before).toBeTruthy();
    expect(byAction.deleted.before.deletedAt).toBeNull();
    expect(byAction.deleted.after).toBeTruthy();
    expect(byAction.deleted.after.deletedAt).toBeTruthy();
    const tombstoneReplace = byAction.deleted.diff.find(
      (op) => op.path === '/deletedAt'
    );
    expect(tombstoneReplace).toBeDefined();
  });

  test('API-level append-only: POST against the audit schema returns 403', async () => {
    const user = await registerUser(ctx.request, ctx.app);

    // POST — blocked by beforeCreate hook
    const post = await ctx
      .request(ctx.app)
      .post('/api/v1/audit')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        userId: 'attacker', action: 'created', resource: 'x',
        resourceId: 'y', at: new Date().toISOString(),
      });
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe('FORBIDDEN');
  });

  test('API-level append-only: PUT / DELETE against a real audit row return 403', async () => {
    // First produce a real audit row owned by this user so the
    // owner-scope check resolves before the hook fires (otherwise
    // we'd get the 404-before-hook path that the framework runs for
    // missing records, which would mask the 403 the hook produces).
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'plugin_audit_appendonly_target',
      collection: 'plugin_audit_appendonly_target',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    });
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/plugin_audit_appendonly_target')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'one' });
    expect(created.status).toBe(201);
    await new Promise((r) => setImmediate(r));

    // Pull the audit row id created for that mutation.
    const list = await ctx
      .request(ctx.app)
      .get('/api/v1/audit?resource=plugin_audit_appendonly_target')
      .set('Authorization', `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    const auditRow = list.body.results.find(
      (r) => r.resource === 'plugin_audit_appendonly_target'
    );
    expect(auditRow).toBeDefined();

    const put = await ctx
      .request(ctx.app)
      .put(`/api/v1/audit/${auditRow._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ resource: 'tampered' });
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe('FORBIDDEN');

    const del = await ctx
      .request(ctx.app)
      .delete(`/api/v1/audit/${auditRow._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe('FORBIDDEN');

    // Sanity check: the row is still present after the failed
    // tampering attempts — append-only at the API layer means the
    // database state is untouched.
    const reread = await ctx
      .request(ctx.app)
      .get(`/api/v1/audit/${auditRow._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(reread.status).toBe(200);
    expect(reread.body.resource).toBe('plugin_audit_appendonly_target');
  });

  test('tenant scope: user A does not see user B audit rows; admin sees both', async () => {
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'plugin_audit_tenant_target',
      collection: 'plugin_audit_tenant_target',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    });

    const userA = await registerUser(ctx.request, ctx.app);
    const userB = await registerUser(ctx.request, ctx.app);

    // Each user creates one record on the target schema.
    const createdA = await ctx
      .request(ctx.app)
      .post('/api/v1/plugin_audit_tenant_target')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ title: 'a' });
    expect(createdA.status).toBe(201);
    const createdB = await ctx
      .request(ctx.app)
      .post('/api/v1/plugin_audit_tenant_target')
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ title: 'b' });
    expect(createdB.status).toBe(201);

    await new Promise((r) => setImmediate(r));

    // userA's view: only their own row for THIS resource. Other test
    // cases may have produced audit rows on the same suite, so filter
    // by resource before counting.
    const listA = await ctx
      .request(ctx.app)
      .get('/api/v1/audit?resource=plugin_audit_tenant_target')
      .set('Authorization', `Bearer ${userA.token}`);
    expect(listA.status).toBe(200);
    const rowsA = listA.body.results.filter(
      (r) => r.resource === 'plugin_audit_tenant_target'
    );
    expect(rowsA.length).toBe(1);
    expect(String(rowsA[0].userId)).toBe(String(userA._id));

    // Promote userA to admin and re-login so the JWT carries the role.
    await User.updateOne({ _id: userA._id }, { $set: { roles: ['admin', 'user'] } });
    const reloginA = await ctx
      .request(ctx.app)
      .post('/login')
      .send({ email: userA.email, password: 'pw12345!' });
    expect(reloginA.status).toBe(200);
    const adminToken = reloginA.body.accessToken;

    const listAdmin = await ctx
      .request(ctx.app)
      .get('/api/v1/audit?resource=plugin_audit_tenant_target')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listAdmin.status).toBe(200);
    const rowsAdmin = listAdmin.body.results.filter(
      (r) => r.resource === 'plugin_audit_tenant_target'
    );
    // Admin sees both users' rows via the acl.list bypass.
    const seenUserIds = new Set(rowsAdmin.map((r) => String(r.userId)));
    expect(seenUserIds.has(String(userA._id))).toBe(true);
    expect(seenUserIds.has(String(userB._id))).toBe(true);
  });

  test('redacts password / token / secret fields in before AND after', async () => {
    // A schema whose payload INTENTIONALLY carries a `password`
    // field — the audit row's before/after must not surface it.
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'plugin_audit_redact_target',
      collection: 'plugin_audit_redact_target',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'email', type: String, required: true },
        { name: 'password', type: String },
      ],
    });

    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/plugin_audit_redact_target')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ email: 'x@y.com', password: 'super-secret' });
    expect(created.status).toBe(201);

    const id = created.body._id;
    const updated = await ctx
      .request(ctx.app)
      .put(`/api/v1/plugin_audit_redact_target/${id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ password: 'rotated-secret' });
    expect(updated.status).toBe(200);

    await new Promise((r) => setImmediate(r));

    const list = await ctx
      .request(ctx.app)
      .get('/api/v1/audit?resource=plugin_audit_redact_target')
      .set('Authorization', `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    const rows = list.body.results.filter(
      (r) => r.resource === 'plugin_audit_redact_target' && r.resourceId === id
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      if (r.before && 'password' in r.before) {
        expect(r.before.password).toBe('[REDACTED]');
      }
      if (r.after && 'password' in r.after) {
        expect(r.after.password).toBe('[REDACTED]');
      }
    }
  });

  test('GraphQL createOne / updateById / removeById produce audit rows with before/after/diff', async () => {
    // GraphQL parity check: a CreateOne + UpdateById + RemoveById on
    // the same record should produce three audit rows whose
    // before/after/diff match what REST produces — proves the
    // scopeResolver wrappers thread req metadata and pre-mutation
    // snapshots through `emitForMutation` (the follow-up to PR #120).
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'plugin_audit_gql_target',
      collection: 'plugin_audit_gql_target',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
        { name: 'amount', type: Number },
      ],
    });

    const user = await registerUser(ctx.request, ctx.app);
    const gql = (query, variables) =>
      ctx
        .request(ctx.app)
        .post('/graphql/')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ query, variables });

    // CreateOne
    const createRes = await gql(`
      mutation Create($r: CreateOneplugin_audit_gql_targetInput!) {
        plugin_audit_gql_targetCreateOne(record: $r) {
          recordId
          record { _id title amount }
        }
      }
    `, { r: { title: 'gql-first', amount: 50 } });
    expect(createRes.body.errors).toBeUndefined();
    const id = createRes.body.data.plugin_audit_gql_targetCreateOne.recordId;

    // UpdateById
    const updateRes = await gql(`
      mutation Upd($id: MongoID!, $r: UpdateByIdplugin_audit_gql_targetInput!) {
        plugin_audit_gql_targetUpdateById(_id: $id, record: $r) {
          record { _id title amount }
        }
      }
    `, { id, r: { amount: 175 } });
    expect(updateRes.body.errors).toBeUndefined();

    // RemoveById
    const removeRes = await gql(`
      mutation Rm($id: MongoID!) {
        plugin_audit_gql_targetRemoveById(_id: $id) {
          recordId
        }
      }
    `, { id });
    expect(removeRes.body.errors).toBeUndefined();

    await new Promise((r) => setImmediate(r));

    const list = await ctx
      .request(ctx.app)
      .get('/api/v1/audit?resource=plugin_audit_gql_target')
      .set('Authorization', `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    const rows = list.body.results.filter(
      (r) => r.resource === 'plugin_audit_gql_target' && r.resourceId === id
    );
    expect(rows).toHaveLength(3);
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(Object.keys(byAction).sort()).toEqual(['created', 'deleted', 'updated']);

    // created: after carries the new payload, before is null.
    expect(byAction.created.before).toBeNull();
    expect(byAction.created.after.title).toBe('gql-first');
    expect(byAction.created.after.amount).toBe(50);
    expect(byAction.created.userId).toBe(String(user._id));

    // updated: before = pre-update, after = post-update — proves
    // `wrapByIdMutation` now fetches `current` even without hooks
    // declared (audit-on-by-default posture, matching REST).
    expect(byAction.updated.before).toBeTruthy();
    expect(byAction.updated.before.amount).toBe(50);
    expect(byAction.updated.after.amount).toBe(175);
    const amountReplace = byAction.updated.diff.find(
      (op) => op.path === '/amount'
    );
    expect(amountReplace).toBeDefined();
    expect(amountReplace.op).toBe('replace');
    expect(amountReplace.value).toBe(175);

    // deleted: before is the pre-delete projection (the
    // graphql-compose-mongoose `removeById` returns the deleted doc
    // under `record`, which IS the before snapshot — the plugin
    // pre-fill maps it correctly), after is null.
    expect(byAction.deleted.before).toBeTruthy();
    expect(byAction.deleted.after).toBeNull();
  });

  test('MCP create_/update_/delete_ tool calls produce audit rows with before/after/diff', async () => {
    // MCP parity check: the tool handlers in utils/mcpServer.js now
    // emit record-bus events (the follow-up to PR #120 — before this
    // change MCP CRUD was invisible to the audit plugin). We drive
    // the in-process MCP server directly so the test asserts the
    // emit path without needing to round-trip JSON-RPC over HTTP.
    const jwt = require('jsonwebtoken');
    const { buildMcpServer } = require('../utils/mcpServer');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'plugin_audit_mcp_target',
      collection: 'plugin_audit_mcp_target',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
        { name: 'amount', type: Number },
      ],
    });

    const user = await registerUser(ctx.request, ctx.app);
    const decodedUser = jwt.decode(user.token);
    // `getReq` simulates the HTTP transport's per-request `req` shape
    // — buildReqMeta needs `req.ip`, `req.get('user-agent')`, and
    // `req.id`. The MCP-driven audit row should carry those three.
    const fakeReq = {
      ip: '10.0.0.42',
      headers: { 'user-agent': 'mcp-integration-test/1.0' },
      get: (h) =>
        h.toLowerCase() === 'user-agent' ? 'mcp-integration-test/1.0' : null,
      id: 'mcp-test-req-id',
    };
    const server = buildMcpServer({
      schemaLoader: ctx.app.locals.schemaLoader,
      getUser: () => decodedUser,
      getReq: () => fakeReq,
      name: 'audit-mcp-test',
    });
    const [transA, transB] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'audit-mcp-client', version: '0.0.1' });
    await Promise.all([server.connect(transB), client.connect(transA)]);

    const parse = (res) => {
      if (res.structuredContent !== undefined) return res.structuredContent;
      const txt = res.content && res.content[0] && res.content[0].text;
      return txt ? JSON.parse(txt) : null;
    };

    let id;
    try {
      // create_
      const createRes = await client.callTool({
        name: 'create_plugin_audit_mcp_target',
        arguments: { record: { title: 'mcp-first', amount: 7 } },
      });
      const created = parse(createRes);
      expect(created._id).toBeDefined();
      id = created._id;

      // update_
      const updateRes = await client.callTool({
        name: 'update_plugin_audit_mcp_target',
        arguments: { id, record: { amount: 42 } },
      });
      expect(parse(updateRes).amount).toBe(42);

      // delete_
      const deleteRes = await client.callTool({
        name: 'delete_plugin_audit_mcp_target',
        arguments: { id },
      });
      expect(parse(deleteRes).softDeleted).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }

    await new Promise((r) => setImmediate(r));

    const list = await ctx
      .request(ctx.app)
      .get('/api/v1/audit?resource=plugin_audit_mcp_target')
      .set('Authorization', `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    const rows = list.body.results.filter(
      (r) => r.resource === 'plugin_audit_mcp_target' && r.resourceId === id
    );
    expect(rows).toHaveLength(3);
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(Object.keys(byAction).sort()).toEqual(['created', 'deleted', 'updated']);

    // created: before null, after carries the payload, req metadata
    // populated from `getReq`.
    expect(byAction.created.before).toBeNull();
    expect(byAction.created.after.title).toBe('mcp-first');
    expect(byAction.created.ip).toBe('10.0.0.42');
    expect(byAction.created.userAgent).toBe('mcp-integration-test/1.0');
    expect(byAction.created.reqId).toBe('mcp-test-req-id');

    // updated: before = pre-update, after = post-update, diff has
    // /amount replace.
    expect(byAction.updated.before.amount).toBe(7);
    expect(byAction.updated.after.amount).toBe(42);
    const amountReplace = byAction.updated.diff.find(
      (op) => op.path === '/amount'
    );
    expect(amountReplace).toBeDefined();
    expect(amountReplace.value).toBe(42);

    // deleted (soft): before has deletedAt null, after has deletedAt set.
    expect(byAction.deleted.before).toBeTruthy();
    expect(byAction.deleted.before.deletedAt).toBeNull();
    expect(byAction.deleted.after.deletedAt).toBeTruthy();
  });
});
