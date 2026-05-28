'use strict';

/**
 * Unit tests for davepi-plugin-stripe. Uses node:test so the package
 * stays zero-runtime-dep on Jest (the framework's main runner).
 *
 * Strategy: createPlugin() with an injected env + fake Stripe SDK,
 * drive setup against a stub Express app and stub schemaLoader, and
 * assert on the recorded calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const stripeModule = require('../index');
const { createPlugin } = stripeModule;

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

function stubApp() {
  const routes = [];
  const app = {
    routes,
    post: (path, ...handlers) => {
      // Express signature: app.post(path, ...middleware, handler).
      // We capture all of them so tests can assert ordering.
      routes.push({ method: 'POST', path, handlers });
    },
  };
  return app;
}

function stubSchemaLoader() {
  const loaded = [];
  const entries = new Map();
  return {
    loaded,
    loadSchema: async (s) => {
      loaded.push(s);
      entries.set(s.path, {
        schema: s,
        model: {
          // Minimal Mongoose-model-shape stub. Tests that exercise
          // the webhook handler use a richer model (see webhook.test.js).
          create: async () => ({}),
          findOneAndUpdate: async () => ({}),
        },
      });
    },
    listSchemas: () => Array.from(entries.keys()),
    getEntry: (key) => entries.get(key) || null,
  };
}

function fakeStripeFactory({ checkoutResult, portalResult, customer, throwOnCustomerCreate } = {}) {
  const calls = { checkoutSessions: [], portalSessions: [], customersCreate: [] };
  const client = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.checkoutSessions.push(params);
          return checkoutResult || { id: 'cs_test_1', url: 'https://checkout.stripe.com/cs_test_1' };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          calls.portalSessions.push(params);
          return portalResult || { url: 'https://billing.stripe.com/p/session/_1' };
        },
      },
    },
    customers: {
      create: async (params, opts) => {
        calls.customersCreate.push({ params, opts });
        if (throwOnCustomerCreate) throw throwOnCustomerCreate;
        return customer || { id: 'cus_fake', email: params.email };
      },
    },
    webhooks: { constructEvent: () => ({ id: 'evt', type: 't', data: { object: {} } }) },
  };
  const factory = (secret /* , opts */) => {
    calls.factorySecret = secret;
    return client;
  };
  factory.calls = calls;
  factory.client = client;
  return factory;
}

function stubUserModel(initial) {
  const docs = new Map();
  if (initial) docs.set(String(initial._id), { ...initial });
  return {
    docs,
    findById: async (id) => docs.get(String(id)) || null,
    findByIdAndUpdate: async (id, patch) => {
      const existing = docs.get(String(id));
      if (!existing) return null;
      const next = { ...existing, ...patch };
      docs.set(String(id), next);
      return next;
    },
    findOne: () => ({ select: () => ({ lean: async () => null }) }),
  };
}

const dummyAuth = () => (_req, _res, next) => next();
const dummyApiLimiter = (_req, _res, next) => next();
const dummyErrors = {
  ValidationError: class ValidationError extends Error { constructor(m) { super(m); this.status = 400; } },
  ForbiddenError:  class ForbiddenError  extends Error { constructor(m) { super(m); this.status = 403; } },
  NotFoundError:   class NotFoundError   extends Error { constructor(m) { super(m); this.status = 404; } },
  AppError:        class AppError        extends Error { constructor(m, s = 500) { super(m); this.status = s; } },
};
// Mirror utils/asyncHandler.js exactly so tests exercise the same
// wrap the framework would apply to plugin routes.
const dummyAsyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

test('default export is a plugin object with name + setup + createCheckoutSession', () => {
  assert.equal(stripeModule.name, 'stripe');
  assert.equal(typeof stripeModule.setup, 'function');
  assert.equal(typeof stripeModule.createCheckoutSession, 'function');
  assert.equal(typeof stripeModule.createPortalSession, 'function');
  assert.equal(typeof stripeModule.onWebhookEvent, 'function');
  assert.equal(typeof stripeModule.createPlugin, 'function');
});

test('dormant when STRIPE_SECRET_KEY is unset; warn logged; helpers throw', async () => {
  const log = capturingLog();
  const plugin = createPlugin({ env: {} });
  await plugin.setup({
    app: stubApp(), schemaLoader: stubSchemaLoader(), bus: new EventEmitter(),
    log, appName: 'demo',
  });
  assert.equal(log.records.warn.length, 1);
  assert.match(log.records.warn[0].msg, /STRIPE_SECRET_KEY not set/);
  await assert.rejects(
    () => plugin.createCheckoutSession({ user: { user_id: 'u1' }, priceId: 'p', successUrl: 's', cancelUrl: 'c' }),
    /dormant/,
  );
  await assert.rejects(
    () => plugin.createPortalSession({ user: { user_id: 'u1' }, returnUrl: 'r' }),
    /dormant/,
  );
});

test('setup registers stripe_event_seen and stripe_subscription schemas', async () => {
  const app = stubApp();
  const schemaLoader = stubSchemaLoader();
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    stripeFactory: fakeStripeFactory(),
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel: stubUserModel(),
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app, schemaLoader, bus: new EventEmitter(), log: silentLog(), appName: 'demo',
  });

  assert.equal(schemaLoader.loaded.length, 2);
  assert.equal(schemaLoader.loaded[0].path, 'stripe_event_seen');
  assert.equal(schemaLoader.loaded[1].path, 'stripe_subscription');
});

test('setup mounts checkout, portal, and (when secret present) webhook routes', async () => {
  const app = stubApp();
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' },
    stripeFactory: fakeStripeFactory(),
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel: stubUserModel(),
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app, schemaLoader: stubSchemaLoader(), bus: new EventEmitter(), log: silentLog(),
  });

  const paths = app.routes.map((r) => r.path).sort();
  assert.deepEqual(paths, ['/api/checkout', '/api/portal', '/api/webhooks/stripe']);

  // Checkout / portal each get apiLimiter + auth(true) + handler — three layers
  const checkout = app.routes.find((r) => r.path === '/api/checkout');
  assert.equal(checkout.handlers.length, 3);
});

test('webhook route is NOT mounted when schemaLoader did not produce the dedupe model', async () => {
  // Use a schemaLoader stub whose loadSchema is a no-op so getEntry
  // returns null for the eventSeen + subscription paths. Mirrors the
  // failure mode where a future framework refactor stops surfacing
  // entries through getEntry; route would otherwise mount and every
  // delivery would 5xx the moment models.eventSeen.create is called.
  const app = stubApp();
  const log = capturingLog();
  const brokenSchemaLoader = {
    loadSchema: async () => {},
    listSchemas: () => [],
    getEntry: () => null,
  };
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' },
    stripeFactory: fakeStripeFactory(),
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel: stubUserModel(),
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app, schemaLoader: brokenSchemaLoader, bus: new EventEmitter(), log,
  });
  assert.equal(app.routes.some((r) => r.path === '/api/webhooks/stripe'), false);
  assert.ok(log.records.error.some((r) => /stripe_event_seen and stripe_subscription models/.test(r.msg)));
});

test('webhook route is NOT mounted when STRIPE_WEBHOOK_SECRET is missing; warn logged', async () => {
  const app = stubApp();
  const log = capturingLog();
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' }, // no STRIPE_WEBHOOK_SECRET
    stripeFactory: fakeStripeFactory(),
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel: stubUserModel(),
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app, schemaLoader: stubSchemaLoader(), bus: new EventEmitter(), log,
  });

  const paths = app.routes.map((r) => r.path);
  assert.equal(paths.includes('/api/webhooks/stripe'), false);
  assert.ok(log.records.warn.some((r) => /STRIPE_WEBHOOK_SECRET missing/.test(r.msg)));
});

test('empty path env disables a specific route', async () => {
  const app = stubApp();
  const plugin = createPlugin({
    env: {
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_PORTAL_PATH: '', // disable portal only
    },
    stripeFactory: fakeStripeFactory(),
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel: stubUserModel(),
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app, schemaLoader: stubSchemaLoader(), bus: new EventEmitter(), log: silentLog(),
  });
  const paths = app.routes.map((r) => r.path);
  assert.equal(paths.includes('/api/portal'), false);
  assert.equal(paths.includes('/api/checkout'), true);
  assert.equal(paths.includes('/api/webhooks/stripe'), true);
});

test('createCheckoutSession: stamps customer, returns session, sets line items', async () => {
  const factory = fakeStripeFactory();
  const userModel = stubUserModel({ _id: 'u1', email: 'u1@example.com' });
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    stripeFactory: factory,
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel,
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app: stubApp(), schemaLoader: stubSchemaLoader(), bus: new EventEmitter(),
    log: silentLog(),
  });

  const session = await plugin.createCheckoutSession({
    user: { user_id: 'u1' },
    priceId: 'price_abc',
    successUrl: 'https://app/success',
    cancelUrl:  'https://app/cancel',
  });
  assert.equal(session.id, 'cs_test_1');
  assert.equal(factory.calls.customersCreate.length, 1);
  assert.equal(factory.calls.customersCreate[0].params.email, 'u1@example.com');
  assert.equal(factory.calls.customersCreate[0].opts.idempotencyKey, 'davepi-customer-u1');

  assert.equal(factory.calls.checkoutSessions.length, 1);
  const params = factory.calls.checkoutSessions[0];
  assert.equal(params.mode, 'subscription');
  assert.equal(params.customer, 'cus_fake');
  assert.equal(params.line_items[0].price, 'price_abc');
  assert.equal(params.success_url, 'https://app/success');
  assert.equal(params.client_reference_id, 'u1');

  // User document now carries stripeCustomerId.
  assert.equal(userModel.docs.get('u1').stripeCustomerId, 'cus_fake');
});

test('createCheckoutSession reuses existing stripeCustomerId without re-creating', async () => {
  const factory = fakeStripeFactory();
  const userModel = stubUserModel({
    _id: 'u1', email: 'u1@example.com', stripeCustomerId: 'cus_existing',
  });
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    stripeFactory: factory,
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel,
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app: stubApp(), schemaLoader: stubSchemaLoader(), bus: new EventEmitter(),
    log: silentLog(),
  });
  await plugin.createCheckoutSession({
    user: { user_id: 'u1' },
    priceId: 'p',
    successUrl: 's',
    cancelUrl:  'c',
  });
  assert.equal(factory.calls.customersCreate.length, 0);
  assert.equal(factory.calls.checkoutSessions[0].customer, 'cus_existing');
});

test('STRIPE_AUTOMATIC_TAX=true threads automatic_tax onto checkout params', async () => {
  const factory = fakeStripeFactory();
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_AUTOMATIC_TAX: 'true' },
    stripeFactory: factory,
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel: stubUserModel({ _id: 'u1', email: 'u1@example.com', stripeCustomerId: 'cus_x' }),
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app: stubApp(), schemaLoader: stubSchemaLoader(), bus: new EventEmitter(),
    log: silentLog(),
  });
  await plugin.createCheckoutSession({
    user: { user_id: 'u1' }, priceId: 'p', successUrl: 's', cancelUrl: 'c',
  });
  assert.deepEqual(factory.calls.checkoutSessions[0].automatic_tax, { enabled: true });
});

test('createPortalSession: stamps customer, returns session url', async () => {
  const factory = fakeStripeFactory();
  const userModel = stubUserModel({ _id: 'u1', email: 'u1@example.com', stripeCustomerId: 'cus_x' });
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    stripeFactory: factory,
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel,
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app: stubApp(), schemaLoader: stubSchemaLoader(), bus: new EventEmitter(),
    log: silentLog(),
  });
  const out = await plugin.createPortalSession({
    user: { user_id: 'u1' },
    returnUrl: 'https://app/account',
  });
  assert.ok(out.url.startsWith('https://billing.stripe.com'));
  assert.equal(factory.calls.portalSessions[0].customer, 'cus_x');
  assert.equal(factory.calls.portalSessions[0].return_url, 'https://app/account');
});

test('createCheckoutSession argument validation: priceId and urls required', async () => {
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    stripeFactory: fakeStripeFactory(),
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel: stubUserModel({ _id: 'u1', email: 'u1@example.com' }),
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app: stubApp(), schemaLoader: stubSchemaLoader(), bus: new EventEmitter(),
    log: silentLog(),
  });
  await assert.rejects(
    () => plugin.createCheckoutSession({ user: { user_id: 'u1' }, successUrl: 's', cancelUrl: 'c' }),
    /priceId/,
  );
  await assert.rejects(
    () => plugin.createCheckoutSession({ user: { user_id: 'u1' }, priceId: 'p', cancelUrl: 'c' }),
    /successUrl/,
  );
});

test('onWebhookEvent registers + returns unsubscribe; arg validation throws', () => {
  const plugin = createPlugin({ env: {} });
  let calls = 0;
  const off = plugin.onWebhookEvent('customer.subscription.updated', () => { calls += 1; });
  assert.equal(typeof off, 'function');
  plugin._emitter.emit('customer.subscription.updated', { fake: true });
  assert.equal(calls, 1);
  off();
  plugin._emitter.emit('customer.subscription.updated', { fake: true });
  assert.equal(calls, 1);

  assert.throws(() => plugin.onWebhookEvent('', () => {}), /event type/);
  assert.throws(() => plugin.onWebhookEvent('x', 'not-a-fn'), /function handler/);
});

test('client getter exposes the underlying Stripe SDK instance after setup', async () => {
  const factory = fakeStripeFactory();
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    stripeFactory: factory,
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel: stubUserModel(),
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  assert.equal(plugin.client, null);
  await plugin.setup({
    app: stubApp(), schemaLoader: stubSchemaLoader(), bus: new EventEmitter(),
    log: silentLog(),
  });
  assert.equal(plugin.client, factory.client);
});

test('refuses helpers when user.user_id is missing', async () => {
  const plugin = createPlugin({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    stripeFactory: fakeStripeFactory(),
    auth: dummyAuth,
    apiLimiter: dummyApiLimiter,
    userModel: stubUserModel(),
    errors: dummyErrors,
    asyncHandler: dummyAsyncHandler,
  });
  await plugin.setup({
    app: stubApp(), schemaLoader: stubSchemaLoader(), bus: new EventEmitter(),
    log: silentLog(),
  });
  await assert.rejects(
    () => plugin.createCheckoutSession({ user: {}, priceId: 'p', successUrl: 's', cancelUrl: 'c' }),
    /user_id/,
  );
  await assert.rejects(
    () => plugin.createPortalSession({ user: {}, returnUrl: 'r' }),
    /user_id/,
  );
});
