'use strict';
require('dotenv').config();

const port = process.env.API_PORT || 5050;
const base = `http://127.0.0.1:${port}`;
const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demo-password!';

async function fetchJson(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function ensureDemoUser() {
  let r = await fetchJson('/login', {
    method: 'POST',
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (r.status === 200) return r.body.accessToken;
  r = await fetchJson('/register', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Demo', last_name: 'User',
      email: DEMO_EMAIL, password: DEMO_PASSWORD,
    }),
  });
  if (r.status !== 201) throw new Error(`register: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

async function post(path, body, auth) {
  const r = await fetchJson(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  if (r.status !== 201) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function put(path, body, auth) {
  const r = await fetchJson(path, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
  if (r.status !== 200) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function main() {
  const token = await ensureDemoUser();
  const auth = { Authorization: `Bearer ${token}` };

  const acme = await post('/api/v1/org', {
    name: 'Acme Co',
    plan: 'starter',
    seats: 10,
  }, auth);
  const globex = await post('/api/v1/org', {
    name: 'Globex',
    plan: 'enterprise',
    seats: 200,
  }, auth);

  await post('/api/v1/workspace', { orgId: acme._id, name: 'Engineering' }, auth);
  await post('/api/v1/workspace', { orgId: acme._id, name: 'Marketing' }, auth);
  await post('/api/v1/workspace', { orgId: globex._id, name: 'EU Region' }, auth);

  const inv = await post('/api/v1/invite', {
    orgId: acme._id,
    email: 'jane@acme.example',
    role: 'admin',
  }, auth);
  await put(`/api/v1/invite/${inv._id}`, { status: 'accepted', acceptedAt: new Date() }, auth);

  await post('/api/v1/invite', {
    orgId: globex._id,
    email: 'bob@globex.example',
    role: 'member',
  }, auth);

  await post('/api/v1/billingEvent', {
    orgId: acme._id, kind: 'upgrade', amount: 99, externalRef: 'ch_seed_1',
  }, auth);
  await post('/api/v1/billingEvent', {
    orgId: globex._id, kind: 'invoice', amount: 4990, externalRef: 'ch_seed_2',
  }, auth);
  await post('/api/v1/billingEvent', {
    orgId: globex._id, kind: 'usage', amount: 220, externalRef: 'usage_seed_1',
  }, auth);

  process.stdout.write(`Seeded 2 orgs, 3 workspaces, 2 invites, 3 billing events as ${DEMO_EMAIL}.\n`);
  process.stdout.write(`Sign in with: ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nSeed failed: ${err.message}\n`);
  process.exit(1);
});
