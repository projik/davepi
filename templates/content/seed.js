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

  const eng = await post('/api/v1/category', {
    name: 'Engineering',
    description: 'Posts about how we build the product.',
  }, auth);
  const launches = await post('/api/v1/category', {
    name: 'Launches',
    description: 'Product announcements and changelogs.',
  }, auth);

  const a1 = await post('/api/v1/article', {
    title: 'How we ship',
    body: 'A short post about our weekly cadence.',
    excerpt: 'Once a week, end-to-end.',
    categoryId: eng._id,
    tags: ['process', 'team'],
    authorName: 'Demo',
  }, auth);
  await put(`/api/v1/article/${a1._id}`, { status: 'review' }, auth);
  await put(`/api/v1/article/${a1._id}`, {
    status: 'published',
    publishedAt: new Date(),
  }, auth);

  await post('/api/v1/article', {
    title: 'Draft: notes for a Q2 retrospective',
    body: 'TBD.',
    categoryId: eng._id,
  }, auth);

  await post('/api/v1/article', {
    title: 'Launch: scaffolder + templates',
    body: 'Run `npx create-davepi-app my-app --template crm` and you\'re running.',
    categoryId: launches._id,
    tags: ['launch'],
    authorName: 'Demo',
  }, auth);

  process.stdout.write(`Seeded 2 categories, 3 articles (1 published, 2 draft) as ${DEMO_EMAIL}.\n`);
  process.stdout.write(`Sign in with: ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nSeed failed: ${err.message}\n`);
  process.exit(1);
});
