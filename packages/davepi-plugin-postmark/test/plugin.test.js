'use strict';

/**
 * Unit tests for davepi-plugin-postmark. Uses node:test so the
 * package stays zero-runtime-dep (Jest is the framework's main test
 * runner but isn't a dep of this package).
 *
 * Strategy: build a fresh plugin via createPlugin() with an injected
 * env and an injected fetch, drive a stub EventEmitter as the bus,
 * and assert what the plugin POSTed to Postmark.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const postmarkModule = require('../index');
const { createPlugin, buildEmailPayload, buildTemplatePayload } = postmarkModule;

function recordingFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ErrorCode: 0, Message: 'OK', MessageID: 'fake-msg-id' }),
    };
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

const TOKEN = 'pm-test-token-12345';
const FROM = 'team@example.com';

test('default export is a plugin object with name + setup + send helpers + createPlugin', () => {
  assert.equal(postmarkModule.name, 'postmark');
  assert.equal(typeof postmarkModule.setup, 'function');
  assert.equal(typeof postmarkModule.sendEmail, 'function');
  assert.equal(typeof postmarkModule.sendTemplate, 'function');
  assert.equal(typeof postmarkModule.sendBatch, 'function');
  assert.equal(typeof postmarkModule.sendBatchTemplates, 'function');
  assert.equal(typeof postmarkModule.createPlugin, 'function');
});

test('dormant when POSTMARK_SERVER_TOKEN is unset; sendEmail throws; warn logged', async () => {
  const fetch = recordingFetch();
  const log = capturingLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({ env: {}, fetch });

  await plugin.setup({ bus, log, appName: 'demo' });

  assert.equal(fetch.calls.length, 0);
  assert.equal(log.records.warn.length, 1);
  assert.match(log.records.warn[0].msg, /POSTMARK_SERVER_TOKEN not set/);

  await assert.rejects(
    () => plugin.sendEmail({ to: 'x@y.com', from: FROM, subject: 'hi', textBody: 'hi' }),
    /dormant/
  );
  await assert.rejects(
    () => plugin.sendTemplate({ to: 'x@y.com', from: FROM, templateAlias: 'welcome' }),
    /dormant/
  );
});

test('rejects an invalid POSTMARK_FROM and stays dormant', async () => {
  const log = capturingLog();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: 'not-an-email' },
    fetch: recordingFetch(),
  });
  await plugin.setup({ bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /not a valid email/);
  await assert.rejects(
    () => plugin.sendEmail({ to: 'x@y.com', subject: 'hi', textBody: 'hi' }),
    /dormant/
  );
});

test('ready-but-quiet when no rules configured; sendEmail works on demand', async () => {
  const fetch = recordingFetch();
  const log = capturingLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
  });

  await plugin.setup({ bus, log, appName: 'my-app' });

  // No automatic forwarding.
  bus.emit('record', { type: 'order.created', recordId: 'r1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 0);

  const result = await plugin.sendEmail({
    to: 'user@example.com',
    subject: 'Welcome',
    textBody: 'Hi there',
  });
  assert.equal(result.MessageID, 'fake-msg-id');
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://api.postmarkapp.com/email');
  assert.equal(fetch.calls[0].headers['X-Postmark-Server-Token'], TOKEN);
  assert.equal(fetch.calls[0].body.From, FROM);
  assert.equal(fetch.calls[0].body.To, 'user@example.com');
  assert.equal(fetch.calls[0].body.Subject, 'Welcome');
  assert.equal(fetch.calls[0].body.TextBody, 'Hi there');
});

test('sendEmail allows per-call overrides for from/replyTo/messageStream', async () => {
  const fetch = recordingFetch();
  const plugin = createPlugin({
    env: {
      POSTMARK_SERVER_TOKEN: TOKEN,
      POSTMARK_FROM: FROM,
      POSTMARK_REPLY_TO: 'replies@example.com',
      POSTMARK_MESSAGE_STREAM: 'outbound',
    },
    fetch,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });

  await plugin.sendEmail({
    to: 'user@example.com',
    from: 'override@example.com',
    replyTo: 'override-reply@example.com',
    messageStream: 'broadcast',
    subject: 'X',
    htmlBody: '<p>hi</p>',
  });
  assert.equal(fetch.calls[0].body.From, 'override@example.com');
  assert.equal(fetch.calls[0].body.ReplyTo, 'override-reply@example.com');
  assert.equal(fetch.calls[0].body.MessageStream, 'broadcast');
  assert.equal(fetch.calls[0].body.HtmlBody, '<p>hi</p>');
});

test('sendEmail joins to/cc/bcc arrays into comma-separated strings', async () => {
  const fetch = recordingFetch();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  await plugin.sendEmail({
    to: ['a@x.com', 'b@x.com'],
    cc: ['c@x.com'],
    bcc: ['d@x.com', 'e@x.com'],
    subject: 'hi',
    textBody: 'hi',
  });
  assert.equal(fetch.calls[0].body.To, 'a@x.com, b@x.com');
  assert.equal(fetch.calls[0].body.Cc, 'c@x.com');
  assert.equal(fetch.calls[0].body.Bcc, 'd@x.com, e@x.com');
});

test('sendTemplate POSTs to /email/withTemplate with TemplateAlias + TemplateModel', async () => {
  const fetch = recordingFetch();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });

  await plugin.sendTemplate({
    to: 'user@example.com',
    templateAlias: 'welcome',
    templateModel: { name: 'Dave', accountUrl: 'https://app.example.com' },
  });
  assert.equal(fetch.calls[0].url, 'https://api.postmarkapp.com/email/withTemplate');
  assert.equal(fetch.calls[0].body.TemplateAlias, 'welcome');
  assert.deepEqual(fetch.calls[0].body.TemplateModel, {
    name: 'Dave',
    accountUrl: 'https://app.example.com',
  });
});

test('sendTemplate accepts numeric templateId as an alternative', async () => {
  const fetch = recordingFetch();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });

  await plugin.sendTemplate({
    to: 'user@example.com',
    templateId: 12345,
    templateModel: { name: 'X' },
  });
  assert.equal(fetch.calls[0].body.TemplateId, 12345);
  assert.equal(fetch.calls[0].body.TemplateAlias, undefined);
});

test('sendBatch POSTs an array body to /email/batch', async () => {
  const fetch = recordingFetch();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });

  await plugin.sendBatch([
    { to: 'a@x.com', subject: 'one', textBody: '1' },
    { to: 'b@x.com', subject: 'two', textBody: '2' },
  ]);
  assert.equal(fetch.calls[0].url, 'https://api.postmarkapp.com/email/batch');
  assert.ok(Array.isArray(fetch.calls[0].body));
  assert.equal(fetch.calls[0].body.length, 2);
  assert.equal(fetch.calls[0].body[0].Subject, 'one');
  assert.equal(fetch.calls[0].body[1].Subject, 'two');
});

test('sendBatchTemplates POSTs { Messages } to /email/batchWithTemplates', async () => {
  const fetch = recordingFetch();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });

  await plugin.sendBatchTemplates([
    { to: 'a@x.com', templateAlias: 'welcome', templateModel: { name: 'a' } },
    { to: 'b@x.com', templateAlias: 'welcome', templateModel: { name: 'b' } },
  ]);
  assert.equal(fetch.calls[0].url, 'https://api.postmarkapp.com/email/batchWithTemplates');
  assert.ok(Array.isArray(fetch.calls[0].body.Messages));
  assert.equal(fetch.calls[0].body.Messages.length, 2);
});

test('rules fire sendTemplate on matching events with build() output', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
    rules: [
      {
        events: 'user.created',
        build: (event) => ({
          to: event.record && event.record.email,
          templateAlias: 'welcome',
          templateModel: { name: event.record && event.record.name },
        }),
      },
    ],
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });

  bus.emit('record', {
    type: 'user.created',
    recordId: 'u1',
    record: { email: 'new@example.com', name: 'New User' },
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://api.postmarkapp.com/email/withTemplate');
  assert.equal(fetch.calls[0].body.To, 'new@example.com');
  assert.equal(fetch.calls[0].body.TemplateAlias, 'welcome');
  assert.deepEqual(fetch.calls[0].body.TemplateModel, { name: 'New User' });
});

test('rule build() returning null skips the send (e.g. record has no email)', async () => {
  const fetch = recordingFetch();
  const log = capturingLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
    rules: [
      {
        events: 'user.*',
        build: (event) => {
          const email = event.record && event.record.email;
          if (!email) return null;
          return { to: email, templateAlias: 'welcome' };
        },
      },
    ],
  });
  await plugin.setup({ bus, log, appName: 'shop' });

  bus.emit('record', { type: 'user.created', recordId: 'u1', record: { /* no email */ } });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 0);
  assert.equal(log.records.error.length, 0);
});

test('non-matching events do not fire rules', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
    rules: [
      {
        events: 'user.created',
        build: (event) => ({ to: 'x@example.com', templateAlias: 'welcome' }),
      },
    ],
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });

  bus.emit('record', { type: 'order.created', recordId: 'o1' });
  bus.emit('record', { type: 'user.updated', recordId: 'u1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 0);
});

test('rule wildcards (user.*) match every verb on the resource', async () => {
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
    rules: [
      {
        events: 'user.*',
        build: (event) => ({ to: 'ops@example.com', templateAlias: 'audit', templateModel: { event: event.type } }),
      },
    ],
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });

  bus.emit('record', { type: 'user.created', recordId: 'u1' });
  bus.emit('record', { type: 'user.updated', recordId: 'u2' });
  bus.emit('record', { type: 'order.created', recordId: 'o1' });
  await new Promise((r) => setImmediate(r));

  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].body.TemplateModel.event, 'user.created');
  assert.equal(fetch.calls[1].body.TemplateModel.event, 'user.updated');
});

test('a failed send inside a rule is logged and never crashes the bus listener', async () => {
  let throwOnce = true;
  const fetch = async () => {
    if (throwOnce) { throwOnce = false; throw new Error('network down'); }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ErrorCode: 0, MessageID: 'id' }),
    };
  };
  const log = capturingLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
    rules: [
      {
        events: 'user.*',
        build: () => ({ to: 'x@example.com', templateAlias: 'welcome' }),
      },
    ],
  });
  await plugin.setup({ bus, log, appName: 'shop' });

  bus.emit('record', { type: 'user.created', recordId: 'u1' });
  bus.emit('record', { type: 'user.updated', recordId: 'u2' });
  await new Promise((r) => setImmediate(r));

  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /rule send failed/);
});

test('Postmark 4xx surfaces ErrorCode + Message in the thrown error', async () => {
  const fetch = async () => ({
    ok: false,
    status: 422,
    text: async () => JSON.stringify({ ErrorCode: 300, Message: 'Invalid email request' }),
  });
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });

  await assert.rejects(
    () => plugin.sendEmail({ to: 'bad', subject: 'x', textBody: 'x' }),
    (err) => {
      assert.match(err.message, /ErrorCode 300/);
      assert.match(err.message, /Invalid email request/);
      assert.equal(err.status, 422);
      assert.equal(err.errorCode, 300);
      return true;
    }
  );
});

test('Postmark 200 with non-zero ErrorCode is also treated as a failure', async () => {
  const fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ErrorCode: 10, Message: 'Bad or missing API token' }),
  });
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  await assert.rejects(
    () => plugin.sendEmail({ to: 'x@y.com', subject: 'x', textBody: 'x' }),
    /ErrorCode 10/
  );
});

test('invalid rules at setup throw (typo guard for operators)', async () => {
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: TOKEN, POSTMARK_FROM: FROM },
    fetch: recordingFetch(),
    rules: [{ events: 'user.created' /* missing build */ }],
  });
  await assert.rejects(
    () => plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' }),
    /build must be a function/
  );
});

test('buildEmailPayload requires from/to/subject and a body', () => {
  assert.throws(() => buildEmailPayload({ to: 'x@y.com', subject: 'x', textBody: 'x' }), /from.*required/);
  assert.throws(() => buildEmailPayload({ from: FROM, subject: 'x', textBody: 'x' }), /to.*required/);
  assert.throws(() => buildEmailPayload({ from: FROM, to: 'x@y.com', textBody: 'x' }), /subject.*required/);
  assert.throws(() => buildEmailPayload({ from: FROM, to: 'x@y.com', subject: 'x' }), /htmlBody.*textBody/);
});

test('buildTemplatePayload requires templateAlias or templateId', () => {
  assert.throws(
    () => buildTemplatePayload({ from: FROM, to: 'x@y.com' }),
    /templateAlias.*templateId/
  );
  assert.throws(
    () => buildTemplatePayload({ from: FROM, to: 'x@y.com', templateId: 'not-a-number' }),
    /templateId.*number/
  );
});

test('appName: POSTMARK_APP_NAME overrides setup({ appName })', async () => {
  // The plugin doesn't currently format a payload field from appName
  // (Postmark messages are user-templated), so we assert that the
  // override merely takes effect by feeding it into a rule's build().
  const fetch = recordingFetch();
  const bus = new EventEmitter();
  const seen = [];
  const plugin = createPlugin({
    env: {
      POSTMARK_SERVER_TOKEN: TOKEN,
      POSTMARK_FROM: FROM,
      POSTMARK_APP_NAME: 'ProductionShop',
    },
    fetch,
    rules: [
      {
        events: 'user.created',
        build: (event, { appName }) => {
          seen.push(appName);
          return { to: 'x@example.com', templateAlias: 'welcome', templateModel: { app: appName } };
        },
      },
    ],
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'whatever' });
  bus.emit('record', { type: 'user.created', recordId: 'u1' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['ProductionShop']);
  assert.equal(fetch.calls[0].body.TemplateModel.app, 'ProductionShop');
});
