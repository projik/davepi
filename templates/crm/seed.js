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
      first_name: 'Demo',
      last_name: 'User',
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
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

  const acme = await post('/api/v1/account', {
    name: 'Acme Industrial',
    industry: 'manufacturing',
    employees: 250,
    description: 'Long-running industrial customer; multi-site rollout.',
  }, auth);

  const globex = await post('/api/v1/account', {
    name: 'Globex Logistics',
    industry: 'transport',
    employees: 1200,
  }, auth);

  await post('/api/v1/contact', {
    parentAccountId: acme._id,
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@acme.example',
    role: 'CTO',
    isPrimary: true,
  }, auth);
  await post('/api/v1/contact', {
    parentAccountId: acme._id,
    firstName: 'John',
    lastName: 'Smith',
    email: 'john@acme.example',
    role: 'VP Eng',
  }, auth);
  await post('/api/v1/contact', {
    parentAccountId: globex._id,
    firstName: 'Maria',
    lastName: 'Lopez',
    email: 'maria@globex.example',
    role: 'CIO',
    isPrimary: true,
  }, auth);

  const dealA = await post('/api/v1/deal', {
    parentAccountId: acme._id,
    title: 'Q1 expansion',
    amount: 50000,
    expectedCloseAt: new Date(Date.now() + 30 * 24 * 3600e3),
  }, auth);
  await put(`/api/v1/deal/${dealA._id}`, { stage: 'qualified' }, auth);
  await put(`/api/v1/deal/${dealA._id}`, { stage: 'proposal' }, auth);

  const dealB = await post('/api/v1/deal', {
    parentAccountId: globex._id,
    title: 'EU rollout',
    amount: 120000,
  }, auth);
  await put(`/api/v1/deal/${dealB._id}`, { stage: 'qualified' }, auth);

  const dealClosed = await post('/api/v1/deal', {
    parentAccountId: acme._id,
    title: 'Renewal 2024',
    amount: 75000,
  }, auth);
  await put(`/api/v1/deal/${dealClosed._id}`, { stage: 'qualified' }, auth);
  await put(`/api/v1/deal/${dealClosed._id}`, { stage: 'proposal' }, auth);
  await put(`/api/v1/deal/${dealClosed._id}`, { stage: 'won', closedAt: new Date() }, auth);

  process.stdout.write(`Seeded 2 accounts, 3 contacts, 3 deals as ${DEMO_EMAIL}.\n`);
  process.stdout.write(`Sign in with: ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nSeed failed: ${err.message}\n`);
  process.exit(1);
});
