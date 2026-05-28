'use strict';

/**
 * Webhook-handler unit tests. The handler is built and driven
 * directly with a stub Stripe SDK (constructEvent injected), stub
 * Mongoose models, and stub req/res so we can assert dedupe,
 * signature-verify failure paths, bus rebroadcast, and subscriber
 * fan-out without a running Mongo or a real Stripe SDK.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { buildWebhookHandler } = require('../lib/webhook');
const { syncSubscriptionFromEvent } = require('../lib/subscription');

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

function stubRes() {
  const res = {
    statusCode: 0,
    body: null,
    sendBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.sendBody = body; return this; },
  };
  return res;
}

// Stub typed errors mirroring utils/errors.js shape so the handler
// can throw / next() them without requiring the framework's actual
// errors module (which would pull mongoose into this zero-dep test).
class StubValidationError extends Error {
  constructor(m) { super(m); this.name = 'ValidationError'; this.status = 400; this.code = 'VALIDATION'; }
}
class StubAppError extends Error {
  constructor(m, status = 500, code = 'INTERNAL') { super(m); this.status = status; this.code = code; }
}
const stubErrors = { ValidationError: StubValidationError, AppError: StubAppError };

function stubNext() {
  const calls = [];
  const fn = (err) => { calls.push(err); };
  fn.calls = calls;
  return fn;
}

function stripeClientThatVerifies(event) {
  return {
    webhooks: {
      constructEvent: (rawBody, sig, secret) => {
        if (sig === 'BAD_SIG') {
          const err = new Error('No signatures found matching the expected signature for payload.');
          throw err;
        }
        return event;
      },
    },
  };
}

function eventSeenModel({ collide = false } = {}) {
  const created = [];
  return {
    created,
    create: async (doc) => {
      if (collide) {
        const err = new Error('duplicate');
        err.code = 11000;
        throw err;
      }
      created.push(doc);
      return doc;
    },
  };
}

function subscriptionModel() {
  const upserts = [];
  return {
    upserts,
    findOneAndUpdate: async (filter, update, opts) => {
      upserts.push({ filter, update, opts });
      return { ...filter, ...update.$set };
    },
  };
}

function userModel({ matchedUserId } = {}) {
  return {
    findOne: () => ({
      select: () => ({
        lean: async () => matchedUserId ? { _id: matchedUserId } : null,
      }),
    }),
  };
}

function waitTick() {
  // Webhook handler defers fan-out via setImmediate. Two ticks make
  // sure both the immediate and any nested microtasks have run.
  return new Promise((r) => setImmediate(() => setImmediate(r)));
}

test('verifies signature, dedupes via eventSeen.create, ACKs 200, emits to bus', async () => {
  const event = {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [] } } },
  };
  const eventSeen = eventSeenModel();
  const bus = new EventEmitter();
  const busEvents = [];
  bus.on('record', (e) => busEvents.push(e));
  const emitter = new EventEmitter();

  const handler = buildWebhookHandler({
    stripeClient: stripeClientThatVerifies(event),
    webhookSecret: 'whsec_x',
    // userModel with matched user so the bus emit resolves userId
    models: { eventSeen, subscription: subscriptionModel(), user: userModel({ matchedUserId: 'u1' }) },
    bus,
    log: silentLog(),
    emitter,
    errors: stubErrors,
  });

  const req = { headers: { 'stripe-signature': 'OK' }, rawBody: Buffer.from('{}') };
  const res = stubRes();
  const next = stubNext();
  await handler(req, res, next);
  await waitTick();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  assert.equal(eventSeen.created.length, 1);
  assert.equal(eventSeen.created[0].eventId, 'evt_1');
  assert.equal(eventSeen.created[0].stripeCustomerId, 'cus_1');
  assert.equal(busEvents.length, 1);
  assert.equal(busEvents[0].type, 'stripe.customer.subscription.updated');
  assert.equal(busEvents[0].recordId, 'sub_1');
  assert.equal(busEvents[0].userId, 'u1');
  assert.equal(busEvents[0].accountId, 'u1');
  assert.equal(next.calls.length, 0);
});

test('skips bus emit when no dAvePi user is linked to the Stripe customer (no audit-write footgun)', async () => {
  const event = {
    id: 'evt_orphan',
    type: 'invoice.paid',
    data: { object: { id: 'in_1', customer: 'cus_unmapped' } },
  };
  const bus = new EventEmitter();
  const busEvents = [];
  bus.on('record', (e) => busEvents.push(e));
  const log = capturingLog();
  const handler = buildWebhookHandler({
    stripeClient: stripeClientThatVerifies(event),
    webhookSecret: 'whsec_x',
    models: { eventSeen: eventSeenModel(), subscription: subscriptionModel(), user: userModel({ matchedUserId: null }) },
    bus,
    log,
    emitter: new EventEmitter(),
    errors: stubErrors,
  });
  await handler({ headers: { 'stripe-signature': 'OK' }, rawBody: Buffer.from('{}') }, stubRes(), stubNext());
  await waitTick();
  assert.equal(busEvents.length, 0);
  assert.ok(log.records.warn.some((r) => /no linked dAvePi user/.test(r.msg)));
});

test('rejects requests with missing Stripe-Signature header via next(ValidationError); no dedupe', async () => {
  const eventSeen = eventSeenModel();
  const handler = buildWebhookHandler({
    stripeClient: stripeClientThatVerifies({ id: 'x', type: 'y', data: { object: {} } }),
    webhookSecret: 'whsec_x',
    models: { eventSeen, subscription: subscriptionModel(), user: userModel() },
    bus: new EventEmitter(),
    log: silentLog(),
    emitter: new EventEmitter(),
    errors: stubErrors,
  });
  const next = stubNext();
  await handler({ headers: {}, rawBody: Buffer.from('{}') }, stubRes(), next);
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0].name, 'ValidationError');
  assert.match(next.calls[0].message, /Missing Stripe-Signature/);
  assert.equal(eventSeen.created.length, 0);
});

test('rejects when rawBody is missing via next(ValidationError); operator log records diagnostic', async () => {
  const log = capturingLog();
  const handler = buildWebhookHandler({
    stripeClient: stripeClientThatVerifies({ id: 'x', type: 'y', data: { object: {} } }),
    webhookSecret: 'whsec_x',
    models: { eventSeen: eventSeenModel(), subscription: subscriptionModel(), user: userModel() },
    bus: new EventEmitter(),
    log,
    emitter: new EventEmitter(),
    errors: stubErrors,
  });
  const next = stubNext();
  await handler({ headers: { 'stripe-signature': 'OK' } }, stubRes(), next);
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0].name, 'ValidationError');
  assert.ok(log.records.error.some((r) => /express\.json\(\) verify hook/.test(r.msg)));
});

test('bad signature -> next(ValidationError) with generic message; no SDK details leak; no dedupe insert', async () => {
  const eventSeen = eventSeenModel();
  const handler = buildWebhookHandler({
    stripeClient: stripeClientThatVerifies({ id: 'x', type: 'y', data: { object: {} } }),
    webhookSecret: 'whsec_x',
    models: { eventSeen, subscription: subscriptionModel(), user: userModel() },
    bus: new EventEmitter(),
    log: silentLog(),
    emitter: new EventEmitter(),
    errors: stubErrors,
  });
  const next = stubNext();
  await handler(
    { headers: { 'stripe-signature': 'BAD_SIG' }, rawBody: Buffer.from('{}') },
    stubRes(),
    next,
  );
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0].name, 'ValidationError');
  assert.match(next.calls[0].message, /Webhook signature verification failed/);
  // The raw SDK error message must NOT leak through the response shape.
  assert.doesNotMatch(next.calls[0].message, /No signatures found/);
  assert.equal(eventSeen.created.length, 0);
});

test('duplicate event (dedupe row exists) short-circuits 200 + duplicate flag', async () => {
  const eventSeen = eventSeenModel({ collide: true });
  const bus = new EventEmitter();
  const busEvents = [];
  bus.on('record', (e) => busEvents.push(e));
  const handler = buildWebhookHandler({
    stripeClient: stripeClientThatVerifies({
      id: 'evt_dup', type: 'customer.subscription.updated', data: { object: { id: 'sub' } },
    }),
    webhookSecret: 'whsec_x',
    models: { eventSeen, subscription: subscriptionModel(), user: userModel() },
    bus,
    log: silentLog(),
    emitter: new EventEmitter(),
    errors: stubErrors,
  });
  const res = stubRes();
  await handler(
    { headers: { 'stripe-signature': 'OK' }, rawBody: Buffer.from('{}') },
    res,
    stubNext(),
  );
  await waitTick();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  // Bus is NOT emitted on duplicate — that's the whole point of dedupe.
  assert.equal(busEvents.length, 0);
});

test('onWebhookEvent subscribers receive the raw Stripe event after ACK', async () => {
  const event = {
    id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_1' } },
  };
  const emitter = new EventEmitter();
  const seen = [];
  emitter.on('invoice.paid', (e) => seen.push(e));
  const handler = buildWebhookHandler({
    stripeClient: stripeClientThatVerifies(event),
    webhookSecret: 'whsec_x',
    models: { eventSeen: eventSeenModel(), subscription: subscriptionModel(), user: userModel() },
    bus: new EventEmitter(),
    log: silentLog(),
    emitter,
    errors: stubErrors,
  });
  const res = stubRes();
  await handler({ headers: { 'stripe-signature': 'OK' }, rawBody: Buffer.from('{}') }, res, stubNext());
  await waitTick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 'evt_2');
});

test('subscriber throw is logged and never blocks subsequent subscribers', async () => {
  const event = { id: 'evt_3', type: 'invoice.paid', data: { object: { id: 'in_2' } } };
  const emitter = new EventEmitter();
  const log = capturingLog();
  let secondCalled = false;
  emitter.on('invoice.paid', () => { throw new Error('handler boom'); });
  emitter.on('invoice.paid', () => { secondCalled = true; });
  const handler = buildWebhookHandler({
    stripeClient: stripeClientThatVerifies(event),
    webhookSecret: 'whsec_x',
    models: { eventSeen: eventSeenModel(), subscription: subscriptionModel(), user: userModel() },
    bus: new EventEmitter(),
    log,
    emitter,
    errors: stubErrors,
  });
  await handler({ headers: { 'stripe-signature': 'OK' }, rawBody: Buffer.from('{}') }, stubRes(), stubNext());
  await waitTick();
  assert.equal(secondCalled, true);
  assert.ok(log.records.error.some((r) => /subscriber threw/.test(r.msg)));
});

test('star subscriber (`*`) sees every event type', async () => {
  const emitter = new EventEmitter();
  const seen = [];
  emitter.on('*', (e) => seen.push(e.type));
  const handler = (event) => buildWebhookHandler({
    stripeClient: stripeClientThatVerifies(event),
    webhookSecret: 'whsec_x',
    models: { eventSeen: eventSeenModel(), subscription: subscriptionModel(), user: userModel() },
    bus: new EventEmitter(),
    log: silentLog(),
    emitter,
    errors: stubErrors,
  });
  await handler({ id: '1', type: 'a.b', data: { object: {} } })(
    { headers: { 'stripe-signature': 'OK' }, rawBody: Buffer.from('{}') },
    stubRes(),
    stubNext(),
  );
  await handler({ id: '2', type: 'c.d', data: { object: {} } })(
    { headers: { 'stripe-signature': 'OK' }, rawBody: Buffer.from('{}') },
    stubRes(),
    stubNext(),
  );
  await waitTick();
  assert.deepEqual(seen, ['a.b', 'c.d']);
});

test('syncSubscriptionFromEvent upserts when a linked user exists', async () => {
  const sub = subscriptionModel();
  const usr = userModel({ matchedUserId: 'user-99' });
  await syncSubscriptionFromEvent({
    event: {
      id: 'evt',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_x',
          customer: 'cus_x',
          status: 'active',
          cancel_at_period_end: false,
          current_period_start: 1700000000,
          current_period_end: 1702592000,
          items: { data: [{ price: { id: 'price_1', product: 'prod_1' } }] },
        },
      },
    },
    models: { subscription: sub, user: usr, eventSeen: eventSeenModel() },
    log: silentLog(),
  });
  assert.equal(sub.upserts.length, 1);
  const { filter, update, opts } = sub.upserts[0];
  assert.deepEqual(filter, { subscriptionId: 'sub_x' });
  assert.equal(opts.upsert, true);
  assert.equal(update.$set.userId, 'user-99');
  assert.equal(update.$set.stripeCustomerId, 'cus_x');
  assert.equal(update.$set.priceId, 'price_1');
  assert.equal(update.$set.productId, 'prod_1');
  assert.ok(update.$set.currentPeriodEnd instanceof Date);
});

test('syncSubscriptionFromEvent skips persist when no linked user (logs warn)', async () => {
  const sub = subscriptionModel();
  const usr = userModel({ matchedUserId: null });
  const log = capturingLog();
  await syncSubscriptionFromEvent({
    event: {
      id: 'evt', type: 'customer.subscription.updated',
      data: { object: { id: 'sub_x', customer: 'cus_unknown', status: 'active', items: { data: [] } } },
    },
    models: { subscription: sub, user: usr, eventSeen: eventSeenModel() },
    log,
  });
  assert.equal(sub.upserts.length, 0);
  assert.ok(log.records.warn.some((r) => /no linked dAvePi user/.test(r.msg)));
});

test('syncSubscriptionFromEvent ignores non-subscription events', async () => {
  const sub = subscriptionModel();
  await syncSubscriptionFromEvent({
    event: { id: 'e', type: 'invoice.paid', data: { object: { id: 'in_1' } } },
    models: { subscription: sub, user: userModel({ matchedUserId: 'u' }), eventSeen: eventSeenModel() },
    log: silentLog(),
  });
  assert.equal(sub.upserts.length, 0);
});
