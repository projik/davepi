'use strict';

/**
 * Unit tests for the top-level plugin surface (dormant mode, sendSms /
 * sendWhatsApp pass-through to the injected Twilio client, config
 * readout). Mirrors davepi-plugin-postmark/test/plugin.test.js in
 * posture: createPlugin() with injected env + client; assert what
 * landed on `client.messages.create`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const twilioModule = require('../index');
const { createPlugin } = twilioModule;

function recordingClient() {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (opts) => {
        calls.push(opts);
        return { sid: 'SM' + (calls.length), status: 'queued' };
      },
    },
    validateRequest: () => true,
  };
}

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLog() };
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

class StubValidationError   extends Error { constructor(m){super(m);this.status=400;this.code='VALIDATION';} }
class StubUnauthorizedError extends Error { constructor(m){super(m);this.status=401;this.code='UNAUTHORIZED';} }
class StubForbiddenError    extends Error { constructor(m){super(m);this.status=403;this.code='FORBIDDEN';} }
class StubNotFoundError     extends Error { constructor(m){super(m);this.status=404;this.code='NOT_FOUND';} }
const stubErrors = {
  ValidationError: StubValidationError,
  UnauthorizedError: StubUnauthorizedError,
  ForbiddenError: StubForbiddenError,
  NotFoundError: StubNotFoundError,
};

test('default export shape: name + setup + send helpers + onInboundSms + createPlugin', () => {
  assert.equal(twilioModule.name, 'twilio');
  assert.equal(typeof twilioModule.setup, 'function');
  assert.equal(typeof twilioModule.sendSms, 'function');
  assert.equal(typeof twilioModule.sendWhatsApp, 'function');
  assert.equal(typeof twilioModule.onInboundSms, 'function');
  assert.equal(typeof twilioModule.verifyTotpForUser, 'function');
  assert.equal(typeof twilioModule.createPlugin, 'function');
});

test('dormant when TWILIO_ACCOUNT_SID is unset; sendSms throws; warn logged', async () => {
  const log = capturingLog();
  const plugin = createPlugin({ env: {} });
  await plugin.setup({ app: null, bus: new EventEmitter(), log, appName: 'demo' });

  assert.equal(log.records.warn.length, 1);
  assert.match(log.records.warn[0].msg, /TWILIO_ACCOUNT_SID not set/);

  await assert.rejects(
    () => plugin.sendSms({ to: '+15555550100', body: 'hi' }),
    /dormant/
  );
  await assert.rejects(
    () => plugin.sendWhatsApp({ to: '+15555550100', body: 'hi' }),
    /dormant/
  );
});

test('dormant when only AUTH_TOKEN missing (and no injected client)', async () => {
  const log = capturingLog();
  const plugin = createPlugin({ env: { TWILIO_ACCOUNT_SID: 'AC123' } });
  await plugin.setup({ app: null, bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /TWILIO_AUTH_TOKEN not set/);
});

test('sendSms uses TWILIO_FROM_NUMBER when no messaging service is configured', async () => {
  const client = recordingClient();
  const plugin = createPlugin({
    env: {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_FROM_NUMBER: '+12025550100',
    },
    twilioClient: client,
    errors: stubErrors,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'demo' });

  await plugin.sendSms({ to: '+15555550100', body: 'hello' });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].to, '+15555550100');
  assert.equal(client.calls[0].body, 'hello');
  assert.equal(client.calls[0].from, '+12025550100');
  assert.equal(client.calls[0].messagingServiceSid, undefined);
});

test('sendSms prefers TWILIO_MESSAGING_SERVICE_SID over from-number', async () => {
  const client = recordingClient();
  const plugin = createPlugin({
    env: {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_FROM_NUMBER: '+12025550100',
      TWILIO_MESSAGING_SERVICE_SID: 'MGabc',
    },
    twilioClient: client,
    errors: stubErrors,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog() });
  await plugin.sendSms({ to: '+15555550100', body: 'hi' });
  assert.equal(client.calls[0].messagingServiceSid, 'MGabc');
  assert.equal(client.calls[0].from, undefined);
});

test('sendSms passes statusCallback through', async () => {
  const client = recordingClient();
  const plugin = createPlugin({
    env: { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+1' },
    twilioClient: client,
    errors: stubErrors,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog() });
  await plugin.sendSms({ to: '+15555550100', body: 'hi', statusCallback: 'https://hooks/sms' });
  assert.equal(client.calls[0].statusCallback, 'https://hooks/sms');
});

test('sendWhatsApp with templateSid sets contentSid + contentVariables JSON', async () => {
  const client = recordingClient();
  const plugin = createPlugin({
    env: {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    },
    twilioClient: client,
    errors: stubErrors,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog() });
  await plugin.sendWhatsApp({
    to: '+15555550100',
    templateSid: 'HX123',
    variables: { 1: 'Alice', 2: '42' },
  });
  assert.equal(client.calls[0].to, 'whatsapp:+15555550100');
  assert.equal(client.calls[0].from, 'whatsapp:+14155238886');
  assert.equal(client.calls[0].contentSid, 'HX123');
  assert.equal(client.calls[0].contentVariables, JSON.stringify({ 1: 'Alice', 2: '42' }));
});

test('sendWhatsApp without templateSid uses body; prepends whatsapp: prefix only if absent', async () => {
  const client = recordingClient();
  const plugin = createPlugin({
    env: {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    },
    twilioClient: client,
    errors: stubErrors,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog() });

  await plugin.sendWhatsApp({ to: 'whatsapp:+15555550100', body: 'plain' });
  assert.equal(client.calls[0].to, 'whatsapp:+15555550100');
  assert.equal(client.calls[0].body, 'plain');
  assert.equal(client.calls[0].contentSid, undefined);
});

test('sendWhatsApp throws if neither templateSid nor body is supplied', async () => {
  const client = recordingClient();
  const plugin = createPlugin({
    env: { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_FROM: 'whatsapp:+1' },
    twilioClient: client,
    errors: stubErrors,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog() });
  await assert.rejects(() => plugin.sendWhatsApp({ to: '+15555550100' }), /templateSid or body/);
});

test('onInboundSms throws on a non-function argument; otherwise returns an unsubscribe fn', () => {
  const plugin = createPlugin({ env: {} });
  assert.throws(() => plugin.onInboundSms('not fn'), /must be a function/);
  const off = plugin.onInboundSms(() => {});
  assert.equal(typeof off, 'function');
  off();
});

test('client getter exposes the underlying SDK client', async () => {
  const client = recordingClient();
  const plugin = createPlugin({
    env: { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+1' },
    twilioClient: client,
    errors: stubErrors,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog() });
  assert.equal(plugin.client, client);
});
