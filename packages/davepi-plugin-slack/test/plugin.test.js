'use strict';

/**
 * Unit tests for davepi-plugin-slack. Uses node:test so the package
 * stays zero-runtime-dep (Jest is the framework's main test runner
 * but isn't a dep of this package).
 *
 * Strategy: build a fresh plugin via createPlugin() with an injected
 * env and an injected fetch, drive a stub EventEmitter as the bus,
 * and assert what the plugin POSTed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const slackModule = require('../index');
const { createPlugin, defaultFormatter } = slackModule;

function recordingFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
    });
    return { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
}

function silentLog() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
    child: () => silentLog(),
  };
}

function capturingLog() {
  const records = { info: [], warn: [], error: [] };
  return {
    info:  (obj, msg) => records.info.push({ obj, msg }),
    warn:  (obj, msg) => records.warn.push({ obj, msg }),
    error: (obj, msg) => records.error.push({ obj, msg }),
    child: () => capturingLog(),
    records,
  };
}

const WEBHOOK = 'https://hooks.slack.com/services/T0/B0/abc123';

test('default export is a plugin object with name + setup + postMessage', () => {
  assert.equal(slackModule.name, 'slack');
  assert.equal(typeof slackModule.setup, 'function');
  assert.equal(typeof slackModule.postMessage, 'function');
  assert.equal(typeof slackModule.createPlugin, 'function');
});

test('dormant when SLACK_WEBHOOK_URL is unset; postMessage throws; warn logged', async () => {
  const fetch = recordingFetch();
  const log = capturingLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({ env: {}, fetch });

  await plugin.setup({ bus, log, appName: 'demo' });

  assert.equal(fetch.calls.length, 0);
  assert.equal(log.records.warn.length, 1);
  assert.match(log.records.warn[0].msg, /SLACK_WEBHOOK_URL not set/);

  await assert.rejects(
    () => plugin.postMessage('hello'),
    /dormant/
  );
});

test('rejects non-https webhook URLs and stays dormant', async () => {
  const fetch = recordingFetch();
  const log = capturingLog();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: 'http://hooks.slack.com/services/X' },
    fetch,
  });

  await plugin.setup({ bus: new EventEmitter(), log, appName: 'demo' });

  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /must be https/);
  await assert.rejects(() => plugin.postMessage('x'), /dormant/);
});

test('rejects an unparseable webhook URL', async () => {
  const log = capturingLog();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: 'not a url at all' },
    fetch: recordingFetch(),
  });
  await plugin.setup({ bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /not a valid URL/);
});

test('ready-but-quiet when SLACK_EVENTS unset; postMessage works on demand', async () => {
  const fetch = recordingFetch();
  const log = capturingLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: WEBHOOK },
    fetch,
  });

  await plugin.setup({ bus, log, appName: 'my-app' });

  // No automatic forwarding.
  bus.emit('record', { type: 'order.created', recordId: 'r1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 0);

  // But ad-hoc use works.
  await plugin.postMessage('welcome user!');
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, WEBHOOK);
  assert.equal(fetch.calls[0].body.text, 'welcome user!');
});

test('forwards events that match a single exact pattern; ignores the rest', async () => {
  const fetch = recordingFetch();
  const log = silentLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: {
      SLACK_WEBHOOK_URL: WEBHOOK,
      SLACK_EVENTS: 'order.created',
    },
    fetch,
  });

  await plugin.setup({ bus, log, appName: 'shop' });

  bus.emit('record', { type: 'order.created', recordId: 'o1' });
  bus.emit('record', { type: 'order.updated', recordId: 'o2' });
  bus.emit('record', { type: 'account.created', recordId: 'a1' });
  await new Promise((r) => setImmediate(r));

  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0].body.text, /\*shop\*/);
  assert.match(fetch.calls[0].body.text, /`order\.created`/);
  assert.match(fetch.calls[0].body.text, /`o1`/);
});

test('resource wildcards (order.*) match every verb on a resource', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: {
      SLACK_WEBHOOK_URL: WEBHOOK,
      SLACK_EVENTS: 'order.*',
    },
    fetch,
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });

  bus.emit('record', { type: 'order.created',     recordId: 'o1' });
  bus.emit('record', { type: 'order.updated',     recordId: 'o2' });
  bus.emit('record', { type: 'order.deleted',     recordId: 'o3' });
  bus.emit('record', { type: 'account.created',   recordId: 'a1' });
  await new Promise((r) => setImmediate(r));

  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(
    fetch.calls.map((c) => c.body.text.match(/`(order\.\w+)`/)[1]),
    ['order.created', 'order.updated', 'order.deleted']
  );
});

test('global wildcard (*) matches every event', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: WEBHOOK, SLACK_EVENTS: '*' },
    fetch,
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });

  bus.emit('record', { type: 'order.created',   recordId: 'o1' });
  bus.emit('record', { type: 'account.deleted', recordId: 'a1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 2);
});

test('multiple patterns are honoured (comma-separated)', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: {
      SLACK_WEBHOOK_URL: WEBHOOK,
      SLACK_EVENTS: 'order.created, account.*',
    },
    fetch,
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });

  bus.emit('record', { type: 'order.created',   recordId: 'o1' });
  bus.emit('record', { type: 'order.updated',   recordId: 'o2' }); // ignored
  bus.emit('record', { type: 'account.deleted', recordId: 'a1' });
  await new Promise((r) => setImmediate(r));

  assert.equal(fetch.calls.length, 2);
});

test('appName: SLACK_APP_NAME overrides setup({ appName })', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: {
      SLACK_WEBHOOK_URL: WEBHOOK,
      SLACK_EVENTS: 'order.created',
      SLACK_APP_NAME: 'ProductionShop',
    },
    fetch,
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'whatever' });

  bus.emit('record', { type: 'order.created', recordId: 'o1' });
  await new Promise((r) => setImmediate(r));

  assert.match(fetch.calls[0].body.text, /\*ProductionShop\*/);
});

test('username + icon_emoji ride along on every post when set', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: {
      SLACK_WEBHOOK_URL: WEBHOOK,
      SLACK_EVENTS: 'order.created',
      SLACK_USERNAME: 'dAvePi bot',
      SLACK_ICON_EMOJI: ':robot_face:',
    },
    fetch,
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  bus.emit('record', { type: 'order.created', recordId: 'o1' });
  await new Promise((r) => setImmediate(r));

  assert.equal(fetch.calls[0].body.username, 'dAvePi bot');
  assert.equal(fetch.calls[0].body.icon_emoji, ':robot_face:');
});

test('bulk events format with numAffected (no recordId)', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: WEBHOOK, SLACK_EVENTS: '*' },
    fetch,
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  bus.emit('record', { type: 'order.updated', filter: { status: 'pending' }, numAffected: 42 });
  await new Promise((r) => setImmediate(r));
  assert.match(fetch.calls[0].body.text, /42 record\(s\) affected/);
});

test('transitioned events format with from -> to', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: WEBHOOK, SLACK_EVENTS: '*' },
    fetch,
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  bus.emit('record', {
    type: 'order.transitioned',
    recordId: 'o1',
    field: 'status',
    from: 'draft',
    to: 'approved',
  });
  await new Promise((r) => setImmediate(r));
  assert.match(fetch.calls[0].body.text, /status: draft → approved/);
});

test('a failed POST is logged and never crashes the bus listener', async () => {
  let throwOnce = true;
  const fetch = async () => {
    if (throwOnce) { throwOnce = false; throw new Error('boom'); }
    return { ok: true, status: 200 };
  };
  const log = capturingLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: WEBHOOK, SLACK_EVENTS: '*' },
    fetch,
  });
  await plugin.setup({ bus, log, appName: 'shop' });

  // First event throws inside the listener — must be caught.
  bus.emit('record', { type: 'order.created', recordId: 'o1' });
  // Second event should still fire.
  bus.emit('record', { type: 'order.created', recordId: 'o2' });
  await new Promise((r) => setImmediate(r));

  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /post failed/);
});

test('non-2xx response from Slack surfaces as a logged error (still no crash)', async () => {
  const fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => 'invalid_payload',
  });
  const log = capturingLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: WEBHOOK, SLACK_EVENTS: '*' },
    fetch,
  });
  await plugin.setup({ bus, log, appName: 'shop' });
  bus.emit('record', { type: 'order.created', recordId: 'o1' });
  await new Promise((r) => setImmediate(r));

  assert.equal(log.records.error.length, 1);
  // The Error's message carries Slack's response body so an operator
  // can spot `invalid_payload` / `channel_not_found` without
  // grepping deeper.
  const errObj = log.records.error[0].obj.err;
  assert.match(errObj.message, /invalid_payload/);
  assert.equal(errObj.status, 400);
});

test('postMessage accepts extras (e.g. blocks) and merges them into the body', async () => {
  const fetch = recordingFetch();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: WEBHOOK },
    fetch,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });

  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }];
  await plugin.postMessage('fallback', { blocks });
  assert.equal(fetch.calls[0].body.text, 'fallback');
  assert.deepEqual(fetch.calls[0].body.blocks, blocks);
});

test('defaultFormatter handles a record event with no recordId and no numAffected', () => {
  const out = defaultFormatter({ type: 'webhook.test' }, { appName: 'shop' });
  assert.match(out, /\*shop\*/);
  assert.match(out, /`webhook\.test`/);
});

test('custom formatter is invoked when supplied', async () => {
  const fetch = recordingFetch();
  const plugin = createPlugin({
    env: { SLACK_WEBHOOK_URL: WEBHOOK, SLACK_EVENTS: '*' },
    fetch,
    formatter: (event, { appName }) => `[${appName}] ${event.type} ${event.recordId || ''}`,
  });
  await plugin.setup({ bus: (() => {
    const b = new EventEmitter();
    queueMicrotask(() => b.emit('record', { type: 'order.created', recordId: 'o9' }));
    return b;
  })(), log: silentLog(), appName: 'shop' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetch.calls[0].body.text, '[shop] order.created o9');
});
