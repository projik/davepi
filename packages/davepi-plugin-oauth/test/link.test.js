'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findOrCreateUser, linkIdentityToUser } = require('../lib/link');

// In-memory stubs that match the slice of mongoose surface findOrCreateUser /
// linkIdentityToUser actually use.

class InMemoryStore {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }
  _matches(row, query) {
    return Object.entries(query).every(([k, v]) => {
      const got = row[k];
      return String(got) === String(v);
    });
  }
  async findOne(query) {
    return this.rows.find((r) => this._matches(r, query)) || null;
  }
  async findById(id) {
    return this.rows.find((r) => String(r._id) === String(id)) || null;
  }
  async create(doc) {
    const row = { _id: this.nextId++, ...doc };
    // emulate `.save()` by returning a row that holds a back-pointer
    // to the store via a non-enumerable property.
    Object.defineProperty(row, '_store', { value: this });
    row.save = async () => row;
    this.rows.push(row);
    return row;
  }
  async deleteOne(query) {
    const i = this.rows.findIndex((r) => this._matches(r, query));
    if (i >= 0) this.rows.splice(i, 1);
  }
}

function makeStubs() {
  const Users = new InMemoryStore();
  const Identities = new InMemoryStore();
  return { Users, Identities };
}

test('first signin via new provider mints a user + an identity row', async () => {
  const { Users, Identities } = makeStubs();
  const profile = {
    providerUserId: 'GID-1',
    email: 'new@example.com',
    firstName: 'New',
    lastName: 'User',
    raw: { sub: 'GID-1' },
  };
  const result = await findOrCreateUser({
    provider: 'google',
    profile,
    User: Users,
    OAuthIdentity: Identities,
  });
  assert.equal(result.created, true);
  assert.equal(result.user.email, 'new@example.com');
  assert.equal(result.user.first_name, 'New');
  assert.deepEqual(result.user.roles, ['user']);
  assert.equal(result.identity.provider, 'google');
  assert.equal(result.identity.providerUserId, 'GID-1');
  assert.equal(Users.rows.length, 1);
  assert.equal(Identities.rows.length, 1);
});

test('returning user via same provider reuses user + updates lastLoginAt', async () => {
  const { Users, Identities } = makeStubs();
  const profile = { providerUserId: 'GID-1', email: 'a@b.com' };
  const first = await findOrCreateUser({
    provider: 'google', profile, User: Users, OAuthIdentity: Identities,
  });
  const old = first.identity.lastLoginAt;
  await new Promise((r) => setTimeout(r, 5));
  const second = await findOrCreateUser({
    provider: 'google', profile, User: Users, OAuthIdentity: Identities,
  });
  assert.equal(second.created, false);
  assert.equal(String(second.user._id), String(first.user._id));
  assert.equal(Users.rows.length, 1);
  assert.equal(Identities.rows.length, 1);
  assert.ok(second.identity.lastLoginAt >= old);
});

test('second provider with same email reuses the existing user (account linking)', async () => {
  const { Users, Identities } = makeStubs();
  // User registered locally first (Users created out-of-band).
  await Users.create({
    email: 'shared@example.com',
    first_name: 'Local',
    last_name: 'User',
    roles: ['user'],
  });
  const googleProfile = { providerUserId: 'GID-9', email: 'shared@example.com' };
  const githubProfile = { providerUserId: 'GH-77', email: 'shared@example.com' };

  const googleResult = await findOrCreateUser({
    provider: 'google', profile: googleProfile, User: Users, OAuthIdentity: Identities,
  });
  assert.equal(googleResult.created, false, 'reuses local user');
  assert.equal(googleResult.user.email, 'shared@example.com');

  const githubResult = await findOrCreateUser({
    provider: 'github', profile: githubProfile, User: Users, OAuthIdentity: Identities,
  });
  assert.equal(githubResult.created, false, 'reuses same local user across providers');
  assert.equal(String(githubResult.user._id), String(googleResult.user._id));

  assert.equal(Users.rows.length, 1, 'one local user');
  assert.equal(Identities.rows.length, 2, 'two distinct identities');
  const providers = Identities.rows.map((r) => r.provider).sort();
  assert.deepEqual(providers, ['github', 'google']);
});

test('email-matching is case-insensitive', async () => {
  const { Users, Identities } = makeStubs();
  await Users.create({ email: 'mixed@example.com', roles: ['user'] });
  const profile = { providerUserId: 'X', email: 'MIXED@Example.com' };
  const result = await findOrCreateUser({
    provider: 'google', profile, User: Users, OAuthIdentity: Identities,
  });
  // Reusing the local user means the email comparison was lowercased.
  assert.equal(result.created, false);
  assert.equal(Users.rows.length, 1);
});

test('linkIdentityToUser binds a provider to an existing user', async () => {
  const { Users, Identities } = makeStubs();
  const user = await Users.create({ email: 'me@example.com', roles: ['user'] });
  const result = await linkIdentityToUser({
    provider: 'github',
    profile: { providerUserId: 'GH-1', email: null },
    userId: user._id,
    OAuthIdentity: Identities,
  });
  assert.equal(result.created, true);
  assert.equal(result.identity.userId, user._id);
});

test('linkIdentityToUser refuses to silently steal an identity owned by someone else', async () => {
  const { Users, Identities } = makeStubs();
  const a = await Users.create({ email: 'a@x.com', roles: ['user'] });
  const b = await Users.create({ email: 'b@x.com', roles: ['user'] });
  await Identities.create({
    userId: a._id, provider: 'github', providerUserId: 'GH-Z', linkedAt: new Date(), lastLoginAt: new Date(),
  });
  await assert.rejects(
    () => linkIdentityToUser({
      provider: 'github',
      profile: { providerUserId: 'GH-Z' },
      userId: b._id,
      OAuthIdentity: Identities,
    }),
    /already linked/
  );
});

test('configurable default roles flow through to newly-created users', async () => {
  const { Users, Identities } = makeStubs();
  const result = await findOrCreateUser({
    provider: 'google',
    profile: { providerUserId: 'NEW', email: 'admin-bootstrap@example.com' },
    User: Users, OAuthIdentity: Identities,
    defaultRoles: ['admin', 'user'],
  });
  assert.deepEqual(result.user.roles, ['admin', 'user']);
});
