/**
 * Integration test for davepi-plugin-slack: load it through the
 * real pluginLoader, against a live schema + bus, and confirm a
 * record mutation triggers a Slack POST.
 *
 * This is the proof that the plugin "just works" when listed in a
 * consumer's `davepi.plugins` array — the package's own
 * test/plugin.test.js mocks the bus; this one drives the bus from
 * a real REST POST.
 */

const path = require('path');
const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

describe('davepi-plugin-slack — end-to-end via pluginLoader', () => {
  test('a REST POST that fires order.created triggers a Slack POST', async () => {
    const { loadPlugins } = require('../utils/pluginLoader');
    const { bus } = require('../utils/events');
    const slackModulePath = path.resolve(
      __dirname,
      '..',
      'packages',
      'davepi-plugin-slack'
    );
    const { createPlugin } = require(slackModulePath);

    // Inject our env + fetch into a fresh plugin instance and feed
    // it through the loader so the same code path the
    // documentation promises ("list it in package.json.davepi.plugins
    // and it works") is exercised end-to-end.
    const fetchCalls = [];
    const fakeFetch = async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    const pluginInstance = createPlugin({
      env: {
        SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
        SLACK_EVENTS: 'plugin_slack_target.created',
        SLACK_APP_NAME: 'integration-test-app',
      },
      fetch: fakeFetch,
    });

    await loadPlugins({
      plugins: [pluginInstance],
      app: ctx.app,
      schemaLoader: ctx.app.locals.schemaLoader,
      bus,
      appName: 'integration-test-app',
    });

    // Load a schema; the plugin should hear its events.
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'plugin_slack_target',
      collection: 'plugin_slack_target',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    });

    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/plugin_slack_target')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'hello slack' });
    expect(created.status).toBe(201);

    // Let the bus listener run.
    await new Promise((r) => setImmediate(r));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://hooks.slack.com/services/T/B/X');
    expect(fetchCalls[0].body.text).toContain('*integration-test-app*');
    expect(fetchCalls[0].body.text).toContain('plugin_slack_target.created');
    expect(fetchCalls[0].body.text).toContain(String(created.body._id));

    // PUT should NOT fire (only .created is configured).
    await ctx
      .request(ctx.app)
      .put(`/api/v1/plugin_slack_target/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'renamed' });
    await new Promise((r) => setImmediate(r));
    expect(fetchCalls).toHaveLength(1);
  });
});
