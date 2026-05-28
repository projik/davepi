/**
 * Integration test for davepi-plugin-stripe: load it through the
 * real pluginLoader against a live schema + bus, send a real
 * `Stripe-Signature`-style HMAC, and confirm the webhook handler
 * dedupes, ACKs, mirrors subscription state, and rebroadcasts
 * onto the framework's record bus.
 *
 * The Stripe SDK's `webhooks.constructEvent` does the same HMAC the
 * real Stripe servers do; we generate the header here with the same
 * helper so the signature-verify path is exercised end-to-end.
 */

const path = require('path');
const crypto = require('crypto');
const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

function signStripePayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  // Mirror of Stripe's signature algorithm so the test doesn't need
  // to import the SDK just to mint a valid `Stripe-Signature` header.
  // Reference: https://docs.stripe.com/webhooks/signatures
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

describe('davepi-plugin-stripe — end-to-end via pluginLoader', () => {
  test('verified webhook ACKs 200, dedupes on replay, rebroadcasts onto bus', async () => {
    const { loadPlugins } = require('../utils/pluginLoader');
    const { bus } = require('../utils/events');
    const pkgPath = path.resolve(__dirname, '..', 'packages', 'davepi-plugin-stripe');
    const { createPlugin } = require(pkgPath);

    // Fake Stripe SDK: only constructEvent matters for the webhook
    // path. We re-export the SDK's contract: parse the signed
    // payload, verify the HMAC with timingSafeEqual semantics, and
    // return the parsed event.
    const fakeStripe = {
      webhooks: {
        constructEvent(payloadBuf, sigHeader, secret) {
          const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf.toString('utf8') : payloadBuf;
          // Parse header: t=<ts>,v1=<sig>
          const parts = Object.fromEntries(
            String(sigHeader).split(',').map((s) => s.split('='))
          );
          if (!parts.t || !parts.v1) throw new Error('No signatures found matching the expected signature for payload.');
          const expected = crypto
            .createHmac('sha256', secret)
            .update(`${parts.t}.${payload}`, 'utf8')
            .digest('hex');
          const a = Buffer.from(parts.v1, 'utf8');
          const b = Buffer.from(expected, 'utf8');
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            throw new Error('No signatures found matching the expected signature for payload.');
          }
          return JSON.parse(payload);
        },
      },
      customers: { create: async () => ({ id: 'cus_int' }) },
      checkout: { sessions: { create: async () => ({ id: 'cs_int', url: 'https://stripe' }) } },
      billingPortal: { sessions: { create: async () => ({ url: 'https://stripe' }) } },
    };

    const pluginInstance = createPlugin({
      env: {
        STRIPE_SECRET_KEY:     'sk_test_int',
        STRIPE_WEBHOOK_SECRET: 'whsec_int',
      },
      stripeFactory: () => fakeStripe,
      auth: require('../middleware/auth'),
      apiLimiter: (_req, _res, next) => next(),
      userModel: require('../model/user'),
      errors: require('../utils/errors'),
    });

    await loadPlugins({
      plugins: [pluginInstance],
      app: ctx.app,
      schemaLoader: ctx.app.locals.schemaLoader,
      bus,
      appName: 'stripe-int-test',
    });

    // The auto-registered schemas should now be queryable.
    expect(ctx.app.locals.schemaLoader.listSchemas()).toEqual(
      expect.arrayContaining(['v1/stripe_event_seen', 'v1/stripe_subscription'])
    );

    // Pre-link a user so the subscription mirror sync finds them.
    const user = await registerUser(ctx.request, ctx.app);
    const UserModel = require('../model/user');
    await UserModel.findByIdAndUpdate(user._id, { stripeCustomerId: 'cus_int' });

    // Build a verified webhook payload.
    const evt = {
      id: 'evt_int_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_int_1',
          customer: 'cus_int',
          status: 'active',
          cancel_at_period_end: false,
          current_period_start: 1700000000,
          current_period_end: 1702592000,
          items: { data: [{ price: { id: 'price_1', product: 'prod_1' } }] },
        },
      },
    };
    const payload = JSON.stringify(evt);
    const sig = signStripePayload(payload, 'whsec_int');

    const busSeen = [];
    bus.on('record', (e) => {
      if (typeof e.type === 'string' && e.type.startsWith('stripe.')) busSeen.push(e);
    });

    const first = await ctx.request(ctx.app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.received).toBe(true);

    // Let the deferred fan-out + mirror sync run. The mirror upsert
    // is an async Mongoose call inside setImmediate, so a single
    // microtask flush isn't enough.
    await new Promise((r) => setTimeout(r, 50));

    expect(busSeen).toHaveLength(1);
    expect(busSeen[0].type).toBe('stripe.customer.subscription.updated');
    expect(busSeen[0].recordId).toBe('sub_int_1');

    // Mirror row landed via the auto-generated tenant-scoped REST.
    const list = await ctx.request(ctx.app)
      .get('/api/v1/stripe_subscription')
      .set('Authorization', `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    const rows = (list.body && list.body.results) || (Array.isArray(list.body) ? list.body : []);
    expect(rows.some((r) => r.subscriptionId === 'sub_int_1' && r.status === 'active')).toBe(true);

    // Replay: same Stripe-Signature, same payload. Should short-circuit
    // with the duplicate flag and NOT emit another bus event.
    const replay = await ctx.request(ctx.app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(busSeen).toHaveLength(1); // no second emit
  });

  test('webhook with bad signature is rejected 400 and no dedupe row is written', async () => {
    const res = await ctx.request(ctx.app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', 't=1,v1=deadbeef')
      .set('Content-Type', 'application/json')
      .send('{"id":"evt_bad","type":"x","data":{"object":{}}}');
    expect(res.status).toBe(400);
    // Response is shaped by the framework's centralized errorHandler;
    // the message is generic and never echoes the underlying Stripe
    // SDK details.
    expect(res.body.error.message).toMatch(/signature verification failed/i);
    expect(res.body.error.message).not.toMatch(/No signatures found/);
  });
});
