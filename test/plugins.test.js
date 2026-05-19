const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const { loadPlugins, resolvePlugin } = require('../utils/pluginLoader');
const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

describe('Plugin loader — programmatic', () => {
  test('runs setup in order, exposes app + schemaLoader + bus + log', async () => {
    const calls = [];
    const fakeApp = { stamp: 'app' };
    const fakeLoader = { stamp: 'loader' };
    const fakeBus = { stamp: 'bus' };
    const loaded = await loadPlugins({
      plugins: [
        {
          name: 'first',
          async setup(api) {
            calls.push({ name: 'first', api });
          },
        },
        {
          name: 'second',
          async setup(api) {
            calls.push({ name: 'second', api });
          },
        },
      ],
      app: fakeApp,
      schemaLoader: fakeLoader,
      bus: fakeBus,
      appName: 'TestApp',
    });

    expect(calls.map((c) => c.name)).toEqual(['first', 'second']);
    expect(loaded.map((l) => l.name)).toEqual(['first', 'second']);
    expect(calls[0].api.app).toBe(fakeApp);
    expect(calls[0].api.schemaLoader).toBe(fakeLoader);
    expect(calls[0].api.bus).toBe(fakeBus);
    expect(calls[0].api.appName).toBe('TestApp');
    expect(calls[0].api.log).toBeDefined();
  });

  test('rejects plugins without a setup function', async () => {
    await expect(
      loadPlugins({
        plugins: [{ name: 'broken' }],
        app: {},
        schemaLoader: {},
        bus: {},
      })
    ).rejects.toThrow(/must export an object with a `setup` function/);
  });
});

describe('Plugin loader — resolution', () => {
  test('relative paths resolve against cwd, absolute paths load as-is', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-plugin-'));
    const pluginFile = path.join(tmpDir, 'p.js');
    fs.writeFileSync(
      pluginFile,
      "module.exports = { name: 'tmp', setup: () => {} };"
    );
    try {
      const fromRelative = resolvePlugin('./p.js', tmpDir);
      expect(fromRelative.name).toBe('tmp');
      const fromAbsolute = resolvePlugin(pluginFile, '/');
      expect(fromAbsolute.name).toBe('tmp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Plugin loader — end-to-end with live app', () => {
  test('plugin mounts a route and subscribes to record events', async () => {
    const user = await registerUser(ctx.request, ctx.app);

    const seen = [];
    const plugin = {
      name: 'inline-test-plugin',
      async setup({ app, bus, schemaLoader, log }) {
        log.info({}, 'plugin setting up');
        app.get('/api/v1/_plugin-ping', (req, res) => {
          res.status(200).json({
            ok: true,
            schemas: schemaLoader.listSchemas().length,
          });
        });
        bus.on('record', (event) => {
          if (event.type.startsWith('plugintest_')) seen.push(event.type);
        });
      },
    };

    await loadPlugins({
      plugins: [plugin],
      app: ctx.app,
      schemaLoader: ctx.app.locals.schemaLoader,
      bus: require('../utils/events').bus,
      appName: 'TestApp',
    });
    // The schema loader's moveErrorHandlerToEnd is what we'd call
    // from app.js after plugins load; call it here to mirror the
    // boot path (the new route appears after every other middleware
    // either way; this just makes errors from the new route flow
    // through errorHandler).
    ctx.app.locals.schemaLoader.moveErrorHandlerToEnd();

    // Custom route is reachable.
    const ping = await ctx.request(ctx.app).get('/api/v1/_plugin-ping');
    expect(ping.status).toBe(200);
    expect(ping.body.ok).toBe(true);
    expect(ping.body.schemas).toBeGreaterThan(0);

    // Event subscription receives record events.
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'plugintest_resource',
      collection: 'plugintest_resource',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    });
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/plugintest_resource')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'hello' });
    expect(created.status).toBe(201);

    // Give the event loop a tick so the bus listener runs.
    await new Promise((r) => setImmediate(r));
    expect(seen).toContain('plugintest_resource.created');
  });
});
