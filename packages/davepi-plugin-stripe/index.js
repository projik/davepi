'use strict';

/**
 * davepi-plugin-stripe
 *
 * Stripe payments + subscriptions + webhooks for dAvePi. Listed
 * under the consumer project's `package.json -> davepi.plugins`:
 *
 *   {
 *     "davepi": { "plugins": ["davepi-plugin-stripe"] }
 *   }
 *
 * What it does:
 *
 *   1. Mounts `POST /api/checkout` and `POST /api/portal` (paths
 *      configurable via env). Both stamp the calling user as the
 *      Stripe customer (auto-create on first hit), require a real
 *      JWT (refuse client-id callers), and return `{ url }` so the
 *      SPA can `window.location = url`.
 *
 *   2. Mounts `POST /api/webhooks/stripe`. Verifies signatures via
 *      Stripe's SDK (constant-time HMAC under the hood), inserts the
 *      event id into `stripe_event_seen` for idempotency, ACKs
 *      Stripe with 200, then fan-outs onto the framework's record
 *      event bus (`stripe.<event.type>`) and to plugin-local
 *      `onWebhookEvent` subscribers.
 *
 *   3. Registers two schema-driven resources via
 *      `schemaLoader.loadSchema(...)`: `stripe_event_seen` (the
 *      idempotency dedupe, TTL 7d) and `stripe_subscription` (a
 *      local mirror of subscription state kept current by the
 *      webhook handler).
 *
 *   4. Exposes a programmatic surface for use from schema lifecycle
 *      hooks:
 *
 *        const stripe = require('davepi-plugin-stripe');
 *        const { url } = await stripe.createCheckoutSession({
 *          user, priceId: 'price_xyz', mode: 'subscription',
 *          successUrl: '...', cancelUrl: '...',
 *        });
 *        const { url } = await stripe.createPortalSession({ user, returnUrl: '...' });
 *        stripe.onWebhookEvent('customer.subscription.updated', async (event) => { ... });
 *        const client = stripe.client; // raw Stripe SDK instance
 *
 * Dormant mode: if `STRIPE_SECRET_KEY` is unset the plugin logs a
 * warning and skips setup. All exported helpers throw with a clear
 * message if called while dormant — mirrors slack / postmark.
 *
 * Coordination with the framework: the webhook handler needs the
 * raw request body for signature verification, but the framework
 * mounts `express.json()` globally before plugins load. The hook
 * is `express.json({ verify: (req, _res, buf) => req.rawBody = buf })`
 * in `app.js`, which stashes the raw bytes for any plugin that
 * needs them without disturbing JSON parsing for every other route.
 * If `req.rawBody` is missing at webhook time, the handler returns
 * 400 with a diagnostic — operators upgrading from an older
 * framework version see a clear pointer at the cause.
 */

const { EventEmitter } = require('events');

const { stripeEventSeenSchema, stripeSubscriptionSchema } = require('./lib/schemas');
const { getOrCreateCustomer } = require('./lib/customer');
const { buildCheckoutHandler, buildPortalHandler } = require('./lib/checkout');
const { buildWebhookHandler } = require('./lib/webhook');

const ENV_KEYS = {
  secretKey:     'STRIPE_SECRET_KEY',
  webhookSecret: 'STRIPE_WEBHOOK_SECRET',
  webhookPath:   'STRIPE_WEBHOOK_PATH',
  checkoutPath:  'STRIPE_CHECKOUT_PATH',
  portalPath:    'STRIPE_PORTAL_PATH',
  apiVersion:    'STRIPE_API_VERSION',
  automaticTax:  'STRIPE_AUTOMATIC_TAX',
};

const DEFAULT_PATHS = {
  webhook:  '/api/webhooks/stripe',
  checkout: '/api/checkout',
  portal:   '/api/portal',
};

function readConfigFromEnv(env) {
  // Empty string disables a route; missing var falls back to default.
  const pick = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    return raw; // '' explicitly disables
  };
  return {
    secretKey:     env[ENV_KEYS.secretKey] || null,
    webhookSecret: env[ENV_KEYS.webhookSecret] || null,
    webhookPath:   pick(ENV_KEYS.webhookPath, DEFAULT_PATHS.webhook),
    checkoutPath:  pick(ENV_KEYS.checkoutPath, DEFAULT_PATHS.checkout),
    portalPath:    pick(ENV_KEYS.portalPath, DEFAULT_PATHS.portal),
    apiVersion:    env[ENV_KEYS.apiVersion] || null,
    automaticTax:  env[ENV_KEYS.automaticTax] === 'true',
  };
}

/**
 * Build a fresh plugin instance. Most consumers don't call this
 * directly — `require('davepi-plugin-stripe')` returns a default
 * instance configured from `process.env`. Use this factory in tests
 * or projects that want to inject a fake Stripe SDK / env.
 *
 * Options (all optional):
 *   - env:          object — env source, defaults to process.env
 *   - stripeFactory: function(secret, opts) -> Stripe-like client,
 *                   defaults to `require('stripe')`. Tests inject
 *                   a fake.
 *   - auth:         function(required) -> express middleware,
 *                   defaults to `require('davepi/middleware/auth')`.
 *                   Tests inject a stub.
 *   - apiLimiter:   express middleware applied to checkout/portal
 *                   routes. Defaults to the framework's `apiLimiter`.
 *   - userModel:    Mongoose model with `stripeCustomerId` field.
 *                   Defaults to `require('davepi/model/user')`.
 *   - errors:       framework error constructors (ValidationError,
 *                   ForbiddenError). Defaults to a lazy
 *                   `require('davepi/utils/errors')` at setup time.
 *   - asyncHandler: framework's `asyncHandler` wrapper. Defaults to
 *                   `require('davepi/utils/asyncHandler')` — tests
 *                   inject a passthrough.
 */
function createPlugin(opts = {}) {
  const env = opts.env || process.env;
  const config = readConfigFromEnv(env);
  const injected = {
    stripeFactory: opts.stripeFactory || null,
    auth:          opts.auth || null,
    apiLimiter:    opts.apiLimiter || null,
    userModel:     opts.userModel || null,
    errors:        opts.errors || null,
    asyncHandler:  opts.asyncHandler || null,
  };

  const state = {
    enabled:       false,
    errors:        null,
    stripeClient:  null,
    webhookSecret: null,
    userModel:     null,
    config,
  };

  // Plugin-local emitter for `onWebhookEvent(type, handler)`. Kept
  // separate from the framework's `record` bus: the webhook handler
  // emits to both, but plugin-local subscribers want to see the raw
  // Stripe event envelope, not the framework's `record` event shape.
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  function ensureEnabled(call) {
    if (!state.enabled) {
      throw new Error(
        `davepi-plugin-stripe: ${call} called but plugin is dormant ` +
        '(STRIPE_SECRET_KEY not set or setup not run yet)'
      );
    }
  }

  async function createCheckoutSession({
    user, priceId, mode, successUrl, cancelUrl, quantity, allowPromotionCodes,
  }) {
    ensureEnabled('createCheckoutSession');
    if (!user || !user.user_id) {
      throw new Error('davepi-plugin-stripe: createCheckoutSession requires user.user_id');
    }
    if (!priceId) throw new Error('davepi-plugin-stripe: createCheckoutSession requires priceId');
    if (!successUrl || !cancelUrl) {
      throw new Error('davepi-plugin-stripe: createCheckoutSession requires successUrl + cancelUrl');
    }
    const customerId = await getOrCreateCustomer({
      stripeClient: state.stripeClient,
      userModel: state.userModel,
      user,
      errors: state.errors,
    });
    const params = {
      mode: mode === 'payment' ? 'payment' : 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: quantity || 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: String(user.user_id),
      allow_promotion_codes: !!allowPromotionCodes,
    };
    if (config.automaticTax) params.automatic_tax = { enabled: true };
    return state.stripeClient.checkout.sessions.create(params);
  }

  async function createPortalSession({ user, returnUrl }) {
    ensureEnabled('createPortalSession');
    if (!user || !user.user_id) {
      throw new Error('davepi-plugin-stripe: createPortalSession requires user.user_id');
    }
    if (!returnUrl) throw new Error('davepi-plugin-stripe: createPortalSession requires returnUrl');
    const customerId = await getOrCreateCustomer({
      stripeClient: state.stripeClient,
      userModel: state.userModel,
      user,
      errors: state.errors,
    });
    return state.stripeClient.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  }

  function onWebhookEvent(eventType, handler) {
    if (typeof eventType !== 'string' || !eventType) {
      throw new TypeError('davepi-plugin-stripe: onWebhookEvent requires an event type string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('davepi-plugin-stripe: onWebhookEvent requires a function handler');
    }
    emitter.on(eventType, handler);
    return () => emitter.off(eventType, handler);
  }

  function resolveDep(name, lazyRequire) {
    if (injected[name]) return injected[name];
    try {
      return lazyRequire();
    } catch (err) {
      const wrapped = new Error(
        `davepi-plugin-stripe: failed to require '${name}' from peerDep 'davepi'. ` +
        'Install davepi or inject via createPlugin({ ' + name + ': ... }). Underlying: ' + err.message
      );
      wrapped.cause = err;
      throw wrapped;
    }
  }

  async function setup({ app, schemaLoader, bus, log, appName }) {
    if (!config.secretKey) {
      log.warn(
        { plugin: 'stripe' },
        'STRIPE_SECRET_KEY not set; davepi-plugin-stripe is dormant'
      );
      return;
    }

    const stripeFactory = injected.stripeFactory || (() => {
      // Lazy-require so `require('davepi-plugin-stripe')` at module
      // load time doesn't pull in the heavy Stripe SDK for projects
      // that haven't configured the plugin yet.
      const Stripe = require('stripe');
      const stripeOpts = {};
      if (config.apiVersion) stripeOpts.apiVersion = config.apiVersion;
      return new Stripe(config.secretKey, stripeOpts);
    });
    state.stripeClient = stripeFactory(config.secretKey, { apiVersion: config.apiVersion });

    state.userModel = resolveDep('userModel', () => require('davepi/model/user'));
    const errors = resolveDep('errors', () => require('davepi/utils/errors'));
    state.errors = errors;

    // Register the schema-driven mirror + dedupe collections so the
    // framework auto-generates REST/GraphQL/Swagger for them. Done
    // before route mounting so the underlying Mongoose models are
    // available when the webhook handler runs.
    if (schemaLoader && typeof schemaLoader.loadSchema === 'function') {
      await schemaLoader.loadSchema(stripeEventSeenSchema);
      await schemaLoader.loadSchema(stripeSubscriptionSchema);
    } else {
      log.warn(
        { plugin: 'stripe' },
        'schemaLoader.loadSchema unavailable; stripe_event_seen and stripe_subscription will not be auto-registered'
      );
    }

    // Registry keys are namespaced by version (`v1/<path>`) — see
    // utils/schemaLoader#loadSchemaImpl. Try the versioned key first
    // and fall back to the bare path so the plugin still works
    // against schema-loader stubs in this package's unit tests.
    const lookup = (path) => {
      if (!schemaLoader || typeof schemaLoader.getEntry !== 'function') return null;
      return schemaLoader.getEntry(`v1/${path}`) || schemaLoader.getEntry(path);
    };
    const eventSeenEntry = lookup('stripe_event_seen');
    const subscriptionEntry = lookup('stripe_subscription');
    const models = {
      eventSeen: eventSeenEntry && eventSeenEntry.model,
      subscription: subscriptionEntry && subscriptionEntry.model,
      user: state.userModel,
    };

    if (!app || typeof app.post !== 'function') {
      log.error(
        { plugin: 'stripe' },
        'no Express app provided to setup(); checkout / portal / webhook routes will not be mounted'
      );
      state.enabled = true;
      return;
    }

    // Resolve auth + apiLimiter + asyncHandler against the framework.
    // These are the same middleware the auto-generated routes use —
    // we want identical posture for billing routes (asyncHandler in
    // particular routes thrown errors through the centralised
    // errorHandler so plugin routes never need their own try/catch).
    const auth = injected.auth || resolveDep('auth', () => require('davepi/middleware/auth'));
    const apiLimiter = injected.apiLimiter
      || resolveDep('apiLimiter', () => require('davepi/middleware/rateLimit').apiLimiter);
    const asyncHandler = injected.asyncHandler
      || resolveDep('asyncHandler', () => require('davepi/utils/asyncHandler'));

    // Webhook route. Stripe sends content-type application/json; the
    // global express.json() has already parsed the body, but its
    // `verify` hook stashed the raw buffer on req.rawBody so signature
    // verification has the bytes it needs.
    //
    // Refuse to mount if the dedupe model isn't available — without
    // it every webhook delivery would 5xx in the handler and Stripe
    // would retry forever. Fail loudly at boot instead.
    if (config.webhookPath && config.webhookSecret) {
      if (!models.eventSeen || !models.subscription) {
        log.error(
          { plugin: 'stripe' },
          'webhook route requires the stripe_event_seen and stripe_subscription models ' +
          'but schemaLoader.loadSchema did not produce them; webhook route NOT mounted'
        );
      } else {
        state.webhookSecret = config.webhookSecret;
        app.post(
          config.webhookPath,
          asyncHandler(buildWebhookHandler({
            stripeClient: state.stripeClient,
            webhookSecret: state.webhookSecret,
            models,
            bus,
            log,
            emitter,
            errors,
          }))
        );
        log.info(
          { plugin: 'stripe', path: config.webhookPath },
          'davepi-plugin-stripe webhook mounted'
        );
      }
    } else if (config.webhookPath && !config.webhookSecret) {
      log.warn(
        { plugin: 'stripe' },
        'STRIPE_WEBHOOK_PATH set but STRIPE_WEBHOOK_SECRET missing; webhook route NOT mounted'
      );
    }

    if (config.checkoutPath) {
      app.post(
        config.checkoutPath,
        apiLimiter,
        auth(true),
        asyncHandler(buildCheckoutHandler({
          stripeClient: state.stripeClient,
          userModel: state.userModel,
          log,
          automaticTax: config.automaticTax,
          errors,
        }))
      );
      log.info(
        { plugin: 'stripe', path: config.checkoutPath },
        'davepi-plugin-stripe checkout route mounted'
      );
    }

    if (config.portalPath) {
      app.post(
        config.portalPath,
        apiLimiter,
        auth(true),
        asyncHandler(buildPortalHandler({
          stripeClient: state.stripeClient,
          userModel: state.userModel,
          log,
          errors,
        }))
      );
      log.info(
        { plugin: 'stripe', path: config.portalPath },
        'davepi-plugin-stripe portal route mounted'
      );
    }

    // Re-assert errorHandler at the tail of the middleware stack so
    // the routes we just mounted route thrown errors through the
    // framework's centralised errorHandler instead of falling through
    // to Express's default 400/500 HTML page. The schema loader
    // already called this after each loadSchema, but the app.post()
    // calls above sit after that re-assertion in the stack, so we
    // need to push errorHandler past them again. Idempotent.
    if (schemaLoader && typeof schemaLoader.moveErrorHandlerToEnd === 'function') {
      schemaLoader.moveErrorHandlerToEnd();
    }

    state.enabled = true;
    log.info(
      { plugin: 'stripe', appName },
      'davepi-plugin-stripe ready'
    );
  }

  const pluginInstance = {
    name: 'stripe',
    setup,
    createCheckoutSession,
    createPortalSession,
    onWebhookEvent,
    get client() {
      return state.stripeClient;
    },
    // Exposed for tests and advanced consumers.
    _state: state,
    _emitter: emitter,
  };

  return pluginInstance;
}

const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
module.exports.stripeEventSeenSchema = stripeEventSeenSchema;
module.exports.stripeSubscriptionSchema = stripeSubscriptionSchema;
