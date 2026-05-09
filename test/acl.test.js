const { setupTestApp, registerUser } = require('./helpers');
const User = require('../model/user');

const ctx = setupTestApp();

/**
 * The schema under test models an HR-style scenario:
 * - `name` and `department` are owned by everyone but department is
 *   admin-only on update.
 * - `salary` is fully ACL'd: admin/hr only on read, admin/hr only on
 *   create, admin only on update.
 * - List + delete bypass user-isolation for admin/hr / admin
 *   respectively.
 */
const employeeSchema = {
  path: 'employee',
  collection: 'employees',
  version: 'v1',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true },
    {
      name: 'salary',
      type: Number,
      acl: {
        read: ['admin', 'hr'],
        create: ['admin', 'hr'],
        update: ['admin'],
      },
    },
    {
      name: 'department',
      type: String,
      acl: { update: ['admin'] },
    },
  ],
  acl: {
    list: ['admin', 'hr'],
    delete: ['admin'],
  },
};

const promoteToRole = async (userId, ...roles) => {
  await User.updateOne({ _id: userId }, { $set: { roles } });
};

const loginAs = async (email, password = 'pw12345!') => {
  const res = await ctx
    .request(ctx.app)
    .post('/login')
    .send({ email, password });
  return res.body.accessToken;
};

/**
 * Register, then immediately promote roles, then login again so the
 * issued JWT carries the new roles.
 */
const registerWithRoles = async (email, ...roles) => {
  const u = await registerUser(ctx.request, ctx.app, { email });
  if (roles.length) {
    await promoteToRole(u._id, ...roles);
    const token = await loginAs(email);
    return { ...u, token, accessToken: token };
  }
  return u;
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

describe('Roles & field-level ACLs', () => {
  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema(employeeSchema);
  });

  describe('User model + JWT', () => {
    test('register defaults the user to roles=["user"]', async () => {
      const u = await registerWithRoles('default@x.com');
      expect(u.user.roles || []).toContain('user');
    });

    test("JWT carries the user's roles after a fresh login", async () => {
      const u = await registerWithRoles('jwt-roles@x.com', 'admin', 'user');
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(u.token, process.env.TOKEN_KEY);
      expect(decoded.roles).toEqual(expect.arrayContaining(['admin', 'user']));
    });
  });

  describe('REST: field-level read projection', () => {
    test('admin sees salary; plain owner does NOT see it on their own record', async () => {
      const owner = await registerWithRoles('rp-owner@x.com', 'user', 'hr');
      const created = await post(
        '/api/v1/employee',
        { name: 'Alice', salary: 100000, department: 'Eng' },
        owner.token
      );
      expect(created.status).toBe(201);
      const id = created.body._id;

      // Demote owner; their own record now hides salary.
      await promoteToRole(owner._id, 'user');
      const plainToken = await loginAs('rp-owner@x.com');
      const r = await get(`/api/v1/employee/${id}`, plainToken);
      expect(r.status).toBe(200);
      expect(r.body.name).toBe('Alice');
      expect(r.body.salary).toBeUndefined();
      expect(r.body.department).toBe('Eng');

      // Admin still sees salary.
      const admin = await registerWithRoles('rp-admin@x.com', 'admin');
      const adminGet = await get(`/api/v1/employee/${id}`, admin.token);
      expect(adminGet.body.salary).toBe(100000);
    });

    test('list response also projects ACL fields', async () => {
      const owner = await registerWithRoles('rl-owner@x.com', 'user', 'hr');
      await post('/api/v1/employee', { name: 'L1', salary: 1 }, owner.token);

      await promoteToRole(owner._id, 'user');
      const plainToken = await loginAs('rl-owner@x.com');
      const r = await get('/api/v1/employee', plainToken);
      expect(r.status).toBe(200);
      const mine = r.body.results.find((rec) => rec.name === 'L1');
      expect(mine).toBeDefined();
      expect(mine.salary).toBeUndefined();
    });
  });

  describe('REST: field-level write filtering', () => {
    test('hr update of department is silently dropped, name still updates', async () => {
      const hr = await registerWithRoles('wf@x.com', 'user', 'hr');
      const created = await post(
        '/api/v1/employee',
        { name: 'Bob', salary: 50000, department: 'Sales' },
        hr.token
      );
      const id = created.body._id;

      // hr can update name but not department (department is admin-only).
      const upd = await put(
        `/api/v1/employee/${id}`,
        { name: 'Bob 2', department: 'HACKED' },
        hr.token
      );
      expect(upd.status).toBe(200);

      const after = await get(`/api/v1/employee/${id}`, hr.token);
      expect(after.body.name).toBe('Bob 2');
      expect(after.body.department).toBe('Sales'); // unchanged
    });

    test('plain user setting salary on create gets it stripped', async () => {
      const user = await registerWithRoles('plain@x.com');
      const created = await post(
        '/api/v1/employee',
        { name: 'Carol', salary: 999999 },
        user.token
      );
      expect(created.status).toBe(201);

      // Verify via a privileged read that salary was never persisted.
      const admin = await registerWithRoles('plain-admin@x.com', 'admin');
      const r = await get(`/api/v1/employee/${created.body._id}`, admin.token);
      expect(r.body.salary).toBeUndefined();
    });
  });

  describe('REST: document-level list bypass (acl.list)', () => {
    test("admin sees every user's records on list; plain user sees only their own", async () => {
      const a = await registerWithRoles('list-a@x.com');
      const b = await registerWithRoles('list-b@x.com');
      await post('/api/v1/employee', { name: 'A-rec' }, a.token);
      await post('/api/v1/employee', { name: 'B-rec' }, b.token);

      const aList = await get('/api/v1/employee', a.token);
      const aNames = aList.body.results.map((r) => r.name);
      expect(aNames).toContain('A-rec');
      expect(aNames).not.toContain('B-rec');

      const admin = await registerWithRoles('list-admin@x.com', 'admin');
      const adminList = await get('/api/v1/employee', admin.token);
      const adminNames = adminList.body.results.map((r) => r.name);
      expect(adminNames).toEqual(expect.arrayContaining(['A-rec', 'B-rec']));
    });

    test('admin can fetch a non-owned record by id; non-admin gets 404', async () => {
      const owner = await registerWithRoles('fid-owner@x.com');
      const created = await post(
        '/api/v1/employee',
        { name: 'private-record' },
        owner.token
      );
      const id = created.body._id;

      const stranger = await registerWithRoles('fid-stranger@x.com');
      const stranger404 = await get(`/api/v1/employee/${id}`, stranger.token);
      expect(stranger404.status).toBe(404);

      const admin = await registerWithRoles('fid-admin@x.com', 'admin');
      const adminFetch = await get(`/api/v1/employee/${id}`, admin.token);
      expect(adminFetch.status).toBe(200);
      expect(adminFetch.body.name).toBe('private-record');
    });
  });

  describe('REST: document-level delete bypass (acl.delete)', () => {
    test("admin deletes a record they don't own; regular user 404s", async () => {
      const owner = await registerWithRoles('del-owner@x.com');
      const created = await post('/api/v1/employee', { name: 'to-be-deleted' }, owner.token);
      const id = created.body._id;

      const stranger = await registerWithRoles('del-stranger@x.com');
      const strangerAttempt = await del(`/api/v1/employee/${id}`, stranger.token);
      expect(strangerAttempt.status).toBe(404);

      const admin = await registerWithRoles('del-admin@x.com', 'admin');
      const adminDel = await del(`/api/v1/employee/${id}`, admin.token);
      expect(adminDel.status).toBe(200);
      expect(adminDel.body.deletedCount).toBe(1);
    });
  });

  describe('REST: backwards compatibility for schemas without acl', () => {
    test('the seed account schema (no acl) still works exactly as before', async () => {
      const a = await registerWithRoles('bc-a@x.com');
      const b = await registerWithRoles('bc-b@x.com');

      const created = await post('/api/v1/account', { accountName: 'A-only' }, a.token);
      expect(created.status).toBe(201);

      // User B can't see User A's account — same as pre-ACL.
      const bList = await get('/api/v1/account', b.token);
      expect(bList.body.totalResults).toBe(0);

      // Even an admin sees nothing — account has no acl.list, so admin
      // role buys nothing on this resource.
      const admin = await registerWithRoles('bc-admin@x.com', 'admin');
      const adminList = await get('/api/v1/account', admin.token);
      expect(adminList.body.totalResults).toBe(0);
    });
  });

  describe('GraphQL: same ACL applies', () => {
    const gql = (token, query, variables) => {
      const r = ctx.request(ctx.app).post('/graphql/').send({ query, variables });
      if (token) r.set('Authorization', `Bearer ${token}`);
      return r;
    };

    test('plain user sees salary as null; admin sees the value', async () => {
      const owner = await registerWithRoles('gql-owner@x.com', 'user', 'hr');
      const created = await gql(
        owner.token,
        'mutation { employeeCreateOne(record: { name: "Dee", salary: 77000 }) { recordId record { _id name salary } } }'
      );
      expect(created.body.errors).toBeUndefined();
      expect(created.body.data.employeeCreateOne.record.salary).toBe(77000);
      const recordId = created.body.data.employeeCreateOne.recordId;

      // Drop the owner to plain user; same record, salary now hidden.
      await promoteToRole(owner._id, 'user');
      const plainToken = await loginAs('gql-owner@x.com');
      const fetchedAsUser = await gql(
        plainToken,
        `query { employeeById(_id: "${recordId}") { name salary } }`
      );
      expect(fetchedAsUser.body.errors).toBeUndefined();
      expect(fetchedAsUser.body.data.employeeById).not.toBeNull();
      expect(fetchedAsUser.body.data.employeeById.name).toBe('Dee');
      expect(fetchedAsUser.body.data.employeeById.salary).toBeNull();

      // Admin sees salary intact across users.
      const admin = await registerWithRoles('gql-admin@x.com', 'admin');
      const fetchedAsAdmin = await gql(
        admin.token,
        `query { employeeById(_id: "${recordId}") { name salary } }`
      );
      expect(fetchedAsAdmin.body.data.employeeById.salary).toBe(77000);
    });
  });
});
