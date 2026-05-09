const { setupTestApp, registerUser } = require('./helpers');
const AuditLog = require('../model/auditLog');
const { computeDiff } = require('../utils/audit');
const { purgeExpiredSoftDeletes } = require('../utils/retention');

const ctx = setupTestApp();

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
const put = (path, body, token) => {
  const r = ctx.request(ctx.app).put(path).send(body);
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r;
};
const del = (path, token) => {
  const r = ctx.request(ctx.app).delete(path);
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r;
};

describe('Soft delete + audit history', () => {
  describe('Soft delete (default)', () => {
    test('DELETE flips deletedAt; subsequent list and GET /:id miss the record', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/account', { accountName: 'softie' }, u.token);
      const id = c.body._id;

      const d = await del(`/api/v1/account/${id}`, u.token);
      expect(d.status).toBe(200);
      expect(d.body.softDeleted).toBe(true);

      const list = await get('/api/v1/account', u.token);
      expect(list.body.totalResults).toBe(0);

      const fetch = await get(`/api/v1/account/${id}`, u.token);
      expect(fetch.status).toBe(404);
    });

    test('?__includeDeleted=true surfaces tombstoned records in list and GET /:id', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/account', { accountName: 'tomb' }, u.token);
      await del(`/api/v1/account/${c.body._id}`, u.token);

      const list = await get('/api/v1/account?__includeDeleted=true', u.token);
      expect(list.body.totalResults).toBe(1);
      expect(list.body.results[0].deletedAt).toBeDefined();
      expect(list.body.results[0].deletedAt).not.toBeNull();

      const fetch = await get(
        `/api/v1/account/${c.body._id}?__includeDeleted=true`,
        u.token
      );
      expect(fetch.status).toBe(200);
      expect(fetch.body._id).toBe(c.body._id);
    });

    test('POST /:id/restore brings the record back to active', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/account', { accountName: 'comeback' }, u.token);
      await del(`/api/v1/account/${c.body._id}`, u.token);
      const r = await post(`/api/v1/account/${c.body._id}/restore`, {}, u.token);
      expect(r.status).toBe(204);

      const list = await get('/api/v1/account', u.token);
      expect(list.body.totalResults).toBe(1);
      expect(list.body.results[0].accountName).toBe('comeback');
    });

    test('restore on a non-tombstoned record 404s', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/account', { accountName: 'live' }, u.token);
      const r = await post(`/api/v1/account/${c.body._id}/restore`, {}, u.token);
      expect(r.status).toBe(404);
    });

    test('cross-user isolation: User B cannot soft-delete or restore User A records', async () => {
      const a = await registerUser(ctx.request, ctx.app);
      const b = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/account', { accountName: 'mine' }, a.token);

      const bDel = await del(`/api/v1/account/${c.body._id}`, b.token);
      expect(bDel.status).toBe(404);

      // Soft-delete as the owner, then User B tries to restore.
      await del(`/api/v1/account/${c.body._id}`, a.token);
      const bRestore = await post(`/api/v1/account/${c.body._id}/restore`, {}, b.token);
      expect(bRestore.status).toBe(404);
    });
  });

  describe('Soft delete opt-out', () => {
    test('schema with softDelete: false hard-deletes (no deletedAt field on the response)', async () => {
      // Load a fresh schema with hard-delete semantics.
      await ctx.app.locals.schemaLoader.loadSchema({
        path: 'hardthing',
        collection: 'hardthings',
        version: 'v1',
        softDelete: false,
        audit: false,
        fields: [
          { name: 'userId', type: String, required: true },
          { name: 'name', type: String, required: true },
        ],
      });
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/hardthing', { name: 'gone' }, u.token);
      expect(c.body.deletedAt).toBeUndefined();

      const d = await del(`/api/v1/hardthing/${c.body._id}`, u.token);
      expect(d.status).toBe(200);
      expect(d.body.softDeleted).toBeUndefined();
      expect(d.body.deletedCount).toBe(1);

      // The record is genuinely gone — even __includeDeleted=true
      // can't surface it.
      const list = await get('/api/v1/hardthing?__includeDeleted=true', u.token);
      expect(list.body.totalResults).toBe(0);
    });
  });

  describe('Audit history', () => {
    test('create / update / delete / restore each write an audit_log entry', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/account', { accountName: 'audited' }, u.token);
      const id = c.body._id;
      await put(`/api/v1/account/${id}`, { accountName: 'audited-v2' }, u.token);
      await del(`/api/v1/account/${id}`, u.token);
      await post(`/api/v1/account/${id}/restore`, {}, u.token);

      const history = await get(`/api/v1/account/${id}/history`, u.token);
      expect(history.status).toBe(200);
      expect(history.body.totalResults).toBe(4);
      const actions = history.body.results.map((r) => r.action);
      // Newest first.
      expect(actions).toEqual(['restore', 'delete', 'update', 'create']);

      const updateEntry = history.body.results.find((r) => r.action === 'update');
      expect(updateEntry.diff.accountName).toEqual(['audited', 'audited-v2']);
      expect(updateEntry.before.accountName).toBe('audited');
      expect(updateEntry.after.accountName).toBe('audited-v2');
    });

    test('history endpoint refuses cross-user reads', async () => {
      const a = await registerUser(ctx.request, ctx.app);
      const b = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/account', { accountName: 'private' }, a.token);
      const r = await get(`/api/v1/account/${c.body._id}/history`, b.token);
      expect(r.status).toBe(404);
    });

    test('schemas with audit: false do NOT populate the audit log', async () => {
      await ctx.app.locals.schemaLoader.loadSchema({
        path: 'noaudit',
        collection: 'noaudits',
        version: 'v1',
        audit: false,
        fields: [
          { name: 'userId', type: String, required: true },
          { name: 'name', type: String, required: true },
        ],
      });
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/noaudit', { name: 'silent' }, u.token);
      await put(`/api/v1/noaudit/${c.body._id}`, { name: 'silent-v2' }, u.token);
      const count = await AuditLog.countDocuments({
        resource: 'noaudit',
        recordId: c.body._id,
      });
      expect(count).toBe(0);
    });
  });

  describe('Soft-deleted records are read-only on the bulk PUT path', () => {
    test('PUT /api/v1/account with a query that matches a tombstoned record does NOT touch it', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/account', { accountName: 'tombbulk' }, u.token);
      await del(`/api/v1/account/${c.body._id}`, u.token);

      // Bulk PUT targeting accountName=tombbulk used to silently
      // mutate the tombstoned doc; with deletedAt:null in the safe
      // query it must NOT modify the existing tombstoned record.
      // (updateMany with upsert:true may still insert a fresh doc;
      // the contract here is "tombstones are read-only", not "no
      // doc anywhere is touched".)
      const r = await ctx.request(ctx.app)
        .put('/api/v1/account?accountName=tombbulk')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ description: 'should not land' });
      expect(r.status).toBe(200);
      expect(r.body.modifiedCount).toBe(0);

      // Confirm the tombstoned record is unchanged.
      const fetched = await get(
        `/api/v1/account/${c.body._id}?__includeDeleted=true`,
        u.token
      );
      expect(fetched.body.description).toBeFalsy();
      expect(fetched.body.deletedAt).not.toBeNull();
    });
  });

  describe('Audit history applies field-level read ACL', () => {
    test('a plain user does NOT see ACL-protected fields in their own audit trail', async () => {
      // Schema with `salary` admin-only on read.
      await ctx.app.locals.schemaLoader.loadSchema({
        path: 'auditemp',
        collection: 'auditemps',
        version: 'v1',
        audit: true,
        fields: [
          { name: 'userId', type: String, required: true },
          { name: 'name', type: String, required: true },
          {
            name: 'salary',
            type: Number,
            acl: { read: ['admin', 'hr'], create: ['admin', 'hr'] },
          },
        ],
      });
      const User = require('../model/user');
      // Bring up an HR-roled user so we can plant a salary.
      const hr = await registerUser(ctx.request, ctx.app, { email: 'hr@a.com' });
      await User.updateOne({ _id: hr._id }, { $set: { roles: ['user', 'hr'] } });
      const fresh = await ctx.request(ctx.app)
        .post('/login')
        .send({ email: 'hr@a.com', password: 'pw12345!' });
      const hrToken = fresh.body.accessToken;

      const c = await post('/api/v1/auditemp', { name: 'X', salary: 90000 }, hrToken);
      const id = c.body._id;
      await put(`/api/v1/auditemp/${id}`, { name: 'X2' }, hrToken);

      // Now a plain user (the same person but downgraded) hits
      // /history. Since they don't have hr/admin, salary must NOT
      // appear in any of: before, after, or diff.
      await User.updateOne({ _id: hr._id }, { $set: { roles: ['user'] } });
      const stale = await ctx.request(ctx.app)
        .post('/login')
        .send({ email: 'hr@a.com', password: 'pw12345!' });
      const plainToken = stale.body.accessToken;
      const history = await get(`/api/v1/auditemp/${id}/history`, plainToken);
      expect(history.status).toBe(200);
      // For each entry, walk the snapshots and the diff: salary must
      // not appear under any of the keys the plain user can see.
      for (const entry of history.body.results) {
        if (entry.before) expect('salary' in entry.before).toBe(false);
        if (entry.after) expect('salary' in entry.after).toBe(false);
        if (entry.diff) expect('salary' in entry.diff).toBe(false);
      }
    });
  });

  describe('Audit log diff is populated for every action', () => {
    test('create / delete / restore each carry a diff (not just update)', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/account', { accountName: 'allthediffs' }, u.token);
      const id = c.body._id;
      await del(`/api/v1/account/${id}`, u.token);
      await post(`/api/v1/account/${id}/restore`, {}, u.token);

      const history = await get(`/api/v1/account/${id}/history`, u.token);
      const byAction = (a) => history.body.results.find((e) => e.action === a);
      // Create: every non-framework field shows null → value.
      expect(byAction('create').diff.accountName).toEqual([null, 'allthediffs']);
      // Delete: deletedAt flips from null → ISO string (or Date —
      // serialized as string through JSON).
      expect(byAction('delete').diff.deletedAt[0]).toBeFalsy();
      expect(byAction('delete').diff.deletedAt[1]).toBeTruthy();
      // Restore: deletedAt flips back.
      expect(byAction('restore').diff.deletedAt[1]).toBeFalsy();
    });
  });

  describe('Retention sweep cascades file-blob cleanup', () => {
    test('aged tombstones with File fields drop both the doc AND the blob', async () => {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-rsweep-'));
      const oldUploads = process.env.UPLOADS_DIR;
      process.env.UPLOADS_DIR = tmp;
      // Reset the cached storage driver so it picks up the new dir.
      require('../utils/storage').resetStorageDriver();
      try {
        await ctx.app.locals.schemaLoader.loadSchema({
          path: 'reaped',
          collection: 'reaped',
          version: 'v1',
          softDelete: { retentionDays: 1 },
          audit: false,
          fields: [
            { name: 'userId', type: String, required: true },
            { name: 'title', type: String, required: true },
            { name: 'attachment', type: 'File', file: { maxBytes: 1024 } },
          ],
        });

        const u = await registerUser(ctx.request, ctx.app);
        const c = await post('/api/v1/reaped', { title: 'with-blob' }, u.token);
        const upload = await ctx.request(ctx.app)
          .post(`/api/v1/reaped/${c.body._id}/attachment`)
          .set('Authorization', `Bearer ${u.token}`)
          .attach('file', Buffer.from('payload'), {
            filename: 'r.txt', contentType: 'text/plain',
          });
        const blobPath = path.join(tmp, upload.body.key);
        expect(fs.existsSync(blobPath)).toBe(true);

        // Soft-delete and backdate so it's eligible for purge.
        await del(`/api/v1/reaped/${c.body._id}`, u.token);
        const Model = require('mongoose').models.reaped;
        await Model.updateOne(
          { _id: c.body._id },
          { $set: { deletedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } }
        );

        const summary = await purgeExpiredSoftDeletes(ctx.app.locals.schemaLoader);
        expect(summary.reaped).toBe(1);
        // Blob is gone, doc is gone.
        expect(fs.existsSync(blobPath)).toBe(false);
      } finally {
        process.env.UPLOADS_DIR = oldUploads;
        require('../utils/storage').resetStorageDriver();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      }
    });
  });

  describe('computeDiff', () => {
    test('returns only fields whose values differ', () => {
      const d = computeDiff(
        { name: 'a', age: 30, _id: 'x', updatedAt: new Date(0) },
        { name: 'b', age: 30, _id: 'x', updatedAt: new Date(1) }
      );
      // updatedAt and _id are framework-owned and excluded.
      expect(d).toEqual({ name: ['a', 'b'] });
    });

    test('captures key additions and removals as null↔value', () => {
      expect(computeDiff({}, { foo: 1 })).toEqual({ foo: [null, 1] });
      expect(computeDiff({ foo: 1 }, {})).toEqual({ foo: [1, null] });
    });
  });

  describe('Retention sweep', () => {
    test('purgeExpiredSoftDeletes hard-deletes records older than the retention window', async () => {
      // Use a fresh schema with a 1-day retention so we can backdate
      // a soft-deleted record and watch it get reaped.
      await ctx.app.locals.schemaLoader.loadSchema({
        path: 'short',
        collection: 'shorts',
        version: 'v1',
        softDelete: { retentionDays: 1 },
        audit: false,
        fields: [
          { name: 'userId', type: String, required: true },
          { name: 'name', type: String, required: true },
        ],
      });
      const u = await registerUser(ctx.request, ctx.app);
      const c = await post('/api/v1/short', { name: 'old' }, u.token);
      const c2 = await post('/api/v1/short', { name: 'fresh' }, u.token);

      const Model = require('mongoose').models.shorts;
      // First record: soft-deleted 2 days ago → eligible for purge.
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await Model.updateOne({ _id: c.body._id }, { $set: { deletedAt: old } });
      // Second: soft-deleted just now → still inside the window.
      await Model.updateOne(
        { _id: c2.body._id },
        { $set: { deletedAt: new Date() } }
      );

      const summary = await purgeExpiredSoftDeletes(
        ctx.app.locals.schemaLoader
      );
      expect(summary.short).toBe(1);

      // The aged record is gone (even __includeDeleted misses it).
      const remaining = await get(
        '/api/v1/short?__includeDeleted=true',
        u.token
      );
      const ids = remaining.body.results.map((r) => r._id);
      expect(ids).not.toContain(c.body._id);
      expect(ids).toContain(c2.body._id);
    });

    test('schemas with softDelete: false are skipped by the retention sweep', async () => {
      const summary = await purgeExpiredSoftDeletes(
        ctx.app.locals.schemaLoader
      );
      // The fresh hardthing schema from earlier opted out — must not
      // appear in the summary regardless of state.
      expect(summary.hardthing).toBeUndefined();
    });
  });
});
