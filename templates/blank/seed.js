/**
 * Seed sample data for the `blank` template.
 *
 * Run: `npm run seed` (after `npm install` and `docker compose up -d`)
 *
 * The script boots an HTTP client against the configured API_PORT,
 * registers (or logs in) a demo user, and POSTs a handful of notes
 * so the admin SPA / MCP surface have something to look at.
 */

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
  // Try to log in first; fall back to register on 400 (no such user).
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
  if (r.status !== 201) {
    throw new Error(
      `Failed to register demo user: ${r.status} ${JSON.stringify(r.body)}`
    );
  }
  return r.body.accessToken;
}

async function main() {
  const token = await ensureDemoUser();
  const auth = { Authorization: `Bearer ${token}` };

  const seed = [
    { title: 'Pinned: ship the launch post', body: 'Hero, video, comparison page.', pinned: true },
    { title: 'Reach out to early users', body: 'Three people from the waitlist.' },
    { title: 'Refactor the auth middleware', body: 'See PR #47 for context.' },
  ];

  for (const note of seed) {
    const r = await fetchJson('/api/v1/note', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(note),
    });
    if (r.status !== 201) {
      throw new Error(
        `Failed to create note: ${r.status} ${JSON.stringify(r.body)}`
      );
    }
    process.stdout.write(`  ✓ ${note.title}\n`);
  }
  process.stdout.write(`\nSeeded ${seed.length} notes as ${DEMO_EMAIL}.\n`);
  process.stdout.write(`Sign in with: ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nSeed failed: ${err.message}\n`);
  process.exit(1);
});
