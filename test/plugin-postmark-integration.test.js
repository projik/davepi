/**
 * Integration test for davepi-plugin-postmark: load it through the
 * real pluginLoader, against a live schema + bus, and confirm a
 * record mutation triggers a Postmark send (via a rule).
 *
 * This is the proof that the plugin "just works" when listed in a
 * consumer's `davepi.plugins` array — the package's own
 * test/plugin.test.js mocks the bus; this one drives the bus from
 * a real REST POST.
 */

const path = require('path');
const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

describe('davepi-plugin-postmark — end-to-end via pluginLoader', () => {
  test('a REST POST that fires <resource>.created triggers a Postmark send via rule', async () => {
    const { loadPlugins } = require('../utils/pluginLoader');
    const { bus } = require('../utils/events');
    const postmarkModulePath = path.resolve(
      __dirname,
      '..',
      'packages',
      'davepi-plugin-postmark'
    );
    const { createPlugin } = require(postmarkModulePath);

    // Inject our env + fetch into a fresh plugin instance and feed
    // it through the loader so the same code path the documentation
    // promises ("list it in package.json.davepi.plugins and it
    // works") is exercised end-to-end.
    const fetchCalls = [];
    const fakeFetch = async (url, init) => {
      fetchCalls.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ErrorCode: 0, MessageID: 'fake-id' }),
      };
    };
    const pluginInstance = createPlugin({
      env: {
        POSTMARK_SERVER_TOKEN: 'pm-integration-token',
        POSTMARK_FROM: 'team@example.com',
        POSTMARK_APP_NAME: 'integration-test-app',
      },
      fetch: fakeFetch,
      rules: [
        {
          events: 'plugin_postmark_target.created',
          build: (event, { appName }) => ({
            to: 'recipient@example.com',
            templateAlias: 'welcome',
            templateModel: {
              app: appName,
              title: event.record && event.record.title,
            },
          }),
        },
      ],
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
      path: 'plugin_postmark_target',
      collection: 'plugin_postmark_target',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    });

    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/plugin_postmark_target')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'hello postmark' });
    expect(created.status).toBe(201);

    // Let the bus listener run.
    await new Promise((r) => setImmediate(r));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://api.postmarkapp.com/email/withTemplate');
    expect(fetchCalls[0].headers['X-Postmark-Server-Token']).toBe('pm-integration-token');
    expect(fetchCalls[0].body.From).toBe('team@example.com');
    expect(fetchCalls[0].body.To).toBe('recipient@example.com');
    expect(fetchCalls[0].body.TemplateAlias).toBe('welcome');
    expect(fetchCalls[0].body.TemplateModel).toEqual({
      app: 'integration-test-app',
      title: 'hello postmark',
    });

    // PUT should NOT fire (only .created is configured).
    await ctx
      .request(ctx.app)
      .put(`/api/v1/plugin_postmark_target/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'renamed' });
    await new Promise((r) => setImmediate(r));
    expect(fetchCalls).toHaveLength(1);
  });

  test('inbound webhook: a POST to the configured path fans out to onInboundEmail subscribers', async () => {
    const { loadPlugins } = require('../utils/pluginLoader');
    const { bus } = require('../utils/events');
    const postmarkModulePath = require('path').resolve(
      __dirname,
      '..',
      'packages',
      'davepi-plugin-postmark'
    );
    const { createPlugin } = require(postmarkModulePath);

    const pluginInstance = createPlugin({
      env: {
        POSTMARK_SERVER_TOKEN: 'pm-tok',
        POSTMARK_FROM:         'team@example.com',
        POSTMARK_INBOUND_PATH: '/webhooks/postmark/inbound-test',
        POSTMARK_INBOUND_AUTH: 'pm-user:pm-pass',
      },
      fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    });

    await loadPlugins({
      plugins: [pluginInstance],
      app: ctx.app,
      schemaLoader: ctx.app.locals.schemaLoader,
      bus,
      appName: 'integration-test-app',
    });

    const received = [];
    pluginInstance.onInboundEmail((msg) => { received.push(msg); });

    const basicAuth =
      'Basic ' + Buffer.from('pm-user:pm-pass', 'utf8').toString('base64');

    // Wrong credentials -> 401.
    const unauth = await ctx
      .request(ctx.app)
      .post('/webhooks/postmark/inbound-test')
      .set('Authorization', 'Basic ' + Buffer.from('nope:nope').toString('base64'))
      .send({ MessageID: 'x', From: 'a@b.com' });
    expect(unauth.status).toBe(401);

    // Malformed body -> 400.
    const bad = await ctx
      .request(ctx.app)
      .post('/webhooks/postmark/inbound-test')
      .set('Authorization', basicAuth)
      .send({ hello: 'world' });
    expect(bad.status).toBe(400);

    // Valid request -> 200 + fan-out.
    const ok = await ctx
      .request(ctx.app)
      .post('/webhooks/postmark/inbound-test')
      .set('Authorization', basicAuth)
      .send({
        MessageID: 'msg-1',
        From: 'sender@example.com',
        To: 'inbox@my-app.com',
        Subject: 'Re: support',
        TextBody: 'thanks',
      });
    expect(ok.status).toBe(200);
    expect(ok.body.MessageID).toBe('msg-1');

    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0].Subject).toBe('Re: support');
    expect(received[0].From).toBe('sender@example.com');
  });
});
