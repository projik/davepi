const { setupTestApp } = require('./helpers');

const ctx = setupTestApp();

// Regression: swagger-ui-express snapshots the spec at setup() time.
// Schemas register asynchronously via app.locals.ready, so the boot-time
// snapshot is empty. The UI page (and its companion swagger-ui-init.js)
// must reflect the live `apiSpec` populated after schemas finish loading.
describe('Swagger UI reflects the live spec', () => {
  test('/api-docs/swagger.json has paths populated', async () => {
    const r = await ctx.request(ctx.app).get('/api-docs/swagger.json');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.paths).length).toBeGreaterThan(0);
  });

  test('/api-docs/ HTML embeds a populated spec (not the empty boot snapshot)', async () => {
    // Hitting the HTML page first triggers setup() to regenerate
    // swagger-ui-init.js against the live apiSpec.
    await ctx.request(ctx.app).get('/api-docs/');
    const init = await ctx.request(ctx.app).get('/api-docs/swagger-ui-init.js');
    expect(init.status).toBe(200);
    expect(init.text).toContain('/api/v1/');
  });
});
