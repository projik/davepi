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

  // Mix of states + priorities so the byStatus / urgentOpen
  // aggregations have something interesting to return.
  const open = await post('/api/v1/ticket', {
    title: 'Login broken on mobile Safari',
    body: 'Steps: open / on iOS 17, tap login, get blank page.',
    reporterId: 'demo',
  }, auth);

  const inProgress = await post('/api/v1/ticket', {
    title: 'Slow query on /accounts list',
    body: 'p95 hit 3s after the last deploy.',
    reporterId: 'demo',
  }, auth);
  await put(`/api/v1/ticket/${inProgress._id}`, { status: 'in_progress', priority: 'high' }, auth);

  const urgent = await post('/api/v1/ticket', {
    title: 'Outage: webhook delivery failing',
    body: 'Stripe webhooks bouncing 500 since 14:00 UTC.',
    reporterId: 'demo',
  }, auth);
  await put(`/api/v1/ticket/${urgent._id}`, { priority: 'high' }, auth);
  await put(`/api/v1/ticket/${urgent._id}`, { priority: 'urgent', status: 'in_progress' }, auth);

  const resolved = await post('/api/v1/ticket', {
    title: 'Typo in welcome email',
    body: 'Says "Welome".',
    reporterId: 'demo',
  }, auth);
  await put(`/api/v1/ticket/${resolved._id}`, { status: 'in_progress' }, auth);
  await put(`/api/v1/ticket/${resolved._id}`, { status: 'resolved', resolvedAt: new Date() }, auth);

  await post('/api/v1/comment', {
    ticketId: inProgress._id,
    body: 'Looks like the new index isn\'t being used. Investigating.',
    authorName: 'Demo',
  }, auth);

  process.stdout.write(`Seeded 4 tickets across all states + 1 comment as ${DEMO_EMAIL}.\n`);
  process.stdout.write(`Sign in with: ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nSeed failed: ${err.message}\n`);
  process.exit(1);
});
