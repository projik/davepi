'use strict';

/**
 * Integration test: boot a real dAvePi backend in-process and verify
 * the agent's MCP client + auth layer respects the ACL boundary.
 *
 * This test deliberately does NOT exercise the LLM / Vercel AI SDK
 * layer — it only verifies that when the agent's mcpClient calls a
 * davepi MCP tool with a constrained identity, davepi returns only
 * the records that identity is allowed to see. That's the safety
 * property worth protecting; the LLM loop is just a fancy way of
 * choosing which tool to call.
 *
 * Boot order matches /home/user/davepi/test/helpers.js:
 *   1. MongoMemoryServer.create
 *   2. set MONGO_URI + TOKEN_KEY env
 *   3. require('davepi/app.js') — which starts schema loading
 *   4. await app.locals.ready
 *   5. listen on a random port
 *
 * If davepi is not installed (e.g. in CI without the workspace),
 * skip the suite gracefully so this package's own unit tests still
 * pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createServiceAuth } = require('../lib/auth/service');
const { createMcpClient } = require('../lib/mcpClient');

let MongoMemoryServer;
let mongoose;
let app;
let registerUser;
let mongo;
let server;
let request;

const davepiRoot = path.resolve(__dirname, '..', '..', '..');

async function boot() {
  try {
    MongoMemoryServer = require('mongodb-memory-server').MongoMemoryServer;
    mongoose = require('mongoose');
  } catch {
    return { ok: false, reason: 'mongodb-memory-server / mongoose not installed' };
  }
  try {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
    process.env.MONGO_URI = mongo.getUri();
    process.env.TOKEN_KEY = process.env.TOKEN_KEY || 'agent-integration-secret';
    process.env.NODE_ENV = 'test';
    process.env.API_PORT = '0';
    await mongoose.connect(process.env.MONGO_URI);
    app = require(path.join(davepiRoot, 'app.js'));
    request = require('supertest');
    ({ registerUser } = require(path.join(davepiRoot, 'test', 'helpers')));
    if (app.locals && app.locals.ready) {
      await app.locals.ready;
    }
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    return { ok: true };
  } catch (err) {
    // Don't fail the suite on environmental issues — the unit suite is
    // the contract, the integration test is best-effort.
    return { ok: false, reason: `davepi boot failed: ${err.message}` };
  }
}

async function teardown() {
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  if (mongoose) {
    await mongoose.disconnect();
  }
  if (mongo) {
    await mongo.stop();
  }
}

let bootResult = { ok: false, reason: 'not yet booted' };
test.before(async () => {
  bootResult = await boot();
});
test.after(async () => {
  if (bootResult.ok) await teardown();
});

test('agent MCP client respects per-user ACL: each user sees only their own records', async (t) => {
  if (!bootResult.ok) return t.skip(bootResult.reason);

  const { port } = server.address();
  const davepiUrl = `http://127.0.0.1:${port}`;

  // Two registered users acting through the agent in service-account
  // mode (each with their own JWT). The agent should see one user's
  // records when authed as that user, and the other's when authed
  // as the other.
  const alice = await registerUser(request, app, { email: `alice-${Date.now()}@x.com` });
  const bob = await registerUser(request, app, { email: `bob-${Date.now()}@x.com` });

  // Seed an `account` record for each user via the auto-generated
  // REST endpoint. (Every davepi schema gets POST /api/v1/{path};
  // the seed `account` schema is in schema/versions/v1.)
  await request(app)
    .post('/api/v1/account')
    .set('Authorization', `Bearer ${alice.accessToken}`)
    .send({ name: 'Alice Co' });
  await request(app)
    .post('/api/v1/account')
    .set('Authorization', `Bearer ${bob.accessToken}`)
    .send({ name: 'Bob LLC' });

  const aliceAgent = createMcpClient({
    davepiUrl,
    auth: createServiceAuth({ bearer: alice.accessToken }),
  });
  const bobAgent = createMcpClient({
    davepiUrl,
    auth: createServiceAuth({ bearer: bob.accessToken }),
  });

  const aliceTools = await aliceAgent.listTools({});
  assert.ok(
    aliceTools.some((t) => t.name === 'list_account'),
    'expected the seed account schema to expose list_account via MCP'
  );

  const aliceResult = await aliceAgent.callTool('list_account', {}, {});
  const bobResult = await bobAgent.callTool('list_account', {}, {});

  // The MCP server returns either structured content or a JSON text
  // payload; helpers.js parses the same way.
  const extract = (r) => {
    if (r.structuredContent !== undefined) return r.structuredContent;
    const txt = r.content?.[0]?.text;
    return txt ? JSON.parse(txt) : null;
  };
  const aliceData = extract(aliceResult);
  const bobData = extract(bobResult);

  const aliceNames = (aliceData?.docs || aliceData?.results || aliceData || []).map((d) => d.name);
  const bobNames = (bobData?.docs || bobData?.results || bobData || []).map((d) => d.name);

  assert.ok(aliceNames.includes('Alice Co'), 'Alice should see her own account');
  assert.ok(!aliceNames.includes('Bob LLC'), 'Alice must not see Bob\'s account (ACL boundary)');
  assert.ok(bobNames.includes('Bob LLC'), 'Bob should see his own account');
  assert.ok(!bobNames.includes('Alice Co'), 'Bob must not see Alice\'s account (ACL boundary)');
});
