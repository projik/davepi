const fs = require('fs');
const path = require('path');
const { setupTestApp } = require('./helpers');

const ctx = setupTestApp();

const adminDist = path.resolve(__dirname, '..', 'admin', 'dist');
const adminBuilt = fs.existsSync(path.join(adminDist, 'index.html'));

/**
 * The admin SPA is a separate workspace under admin/. Tests here
 * only run when a build is present (admin/dist/index.html). On a
 * fresh clone without `npm run build:admin`, these are skipped
 * cleanly so the rest of the suite passes.
 */
const maybe = adminBuilt ? describe : describe.skip;

maybe('Admin UI (built artifacts)', () => {
  test('GET /admin returns the SPA index.html', async () => {
    const r = await ctx.request(ctx.app).get('/admin/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    expect(r.text).toContain('<div id="root">');
    expect(r.text).toContain('/admin/');
  });

  test('SPA fallback: deep links return the same index.html', async () => {
    // Refine routes /admin/<resource>/... client-side; the server
    // must serve index.html for any unmatched path under /admin so
    // a refresh works.
    const r = await ctx.request(ctx.app).get('/admin/account/show/abc123');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<div id="root">');
  });

  test('static asset bundle is reachable under /admin/assets', async () => {
    const assets = fs.readdirSync(path.join(adminDist, 'assets'));
    const js = assets.find((f) => f.endsWith('.js'));
    expect(js).toBeDefined();
    const r = await ctx.request(ctx.app).get(`/admin/assets/${js}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/javascript/);
  });

  test('the admin spa references /api-docs/swagger.json (the discovery target)', async () => {
    const assets = fs.readdirSync(path.join(adminDist, 'assets'));
    const js = assets.find((f) => f.endsWith('.js'));
    const body = fs.readFileSync(path.join(adminDist, 'assets', js), 'utf8');
    expect(body).toContain('/api-docs/swagger.json');
  });
});

if (!adminBuilt) {
  describe('Admin UI (skipped — no build)', () => {
    test('skipped because admin/dist/index.html is absent', () => {
      // Sentinel test so this file isn't entirely empty when skipped.
      // Real coverage runs on contributor machines / CI after
      // `npm run build:admin`.
      expect(adminBuilt).toBe(false);
    });
  });
}
