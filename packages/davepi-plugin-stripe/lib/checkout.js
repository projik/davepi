'use strict';

/**
 * Express handlers for `POST /api/checkout` and `POST /api/portal`.
 *
 * Both:
 *   - require `auth(true)` (a real JWT, not a client-id) — billing
 *     surfaces are user-scoped by definition;
 *   - resolve (or create) the caller's Stripe customer via
 *     `getOrCreateCustomer`;
 *   - call into the Stripe SDK to mint a session and return
 *     `{ url }` so the SPA can redirect.
 *
 * Refuse client-id callers: `req.user.isClient === true` means the
 * caller authenticated via `X-Client-Id`, which is a public
 * identifier baked into SPA bundles. Letting a client-id mint
 * checkout sessions would let anyone with the public client id
 * create Stripe sessions on behalf of arbitrary customers — same
 * reasoning as the GraphQL/REST mutation refusal in `clientAuth.js`.
 */

const { getOrCreateCustomer } = require('./customer');

function refuseClientAuth(user) {
  if (user && user.isClient) {
    const err = new Error('davepi-plugin-stripe: client-id callers cannot create checkout/portal sessions');
    err.status = 403;
    return err;
  }
  return null;
}

function buildCheckoutHandler({ stripeClient, userModel, log, automaticTax, errors }) {
  const { ValidationError, ForbiddenError } = errors;
  return async function checkoutHandler(req, res, next) {
    try {
      const refused = refuseClientAuth(req.user);
      if (refused) return next(new ForbiddenError(refused.message));

      const { priceId, mode, successUrl, cancelUrl, quantity, allowPromotionCodes } = req.body || {};
      if (!priceId || typeof priceId !== 'string') {
        return next(new ValidationError('priceId is required'));
      }
      if (!successUrl || !cancelUrl) {
        return next(new ValidationError('successUrl and cancelUrl are required'));
      }
      const sessionMode = mode === 'payment' ? 'payment' : 'subscription';

      const customerId = await getOrCreateCustomer({
        stripeClient,
        userModel,
        user: req.user,
        log,
      });

      const params = {
        mode: sessionMode,
        customer: customerId,
        line_items: [{ price: priceId, quantity: quantity || 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: String(req.user.user_id),
        allow_promotion_codes: !!allowPromotionCodes,
      };
      if (automaticTax) params.automatic_tax = { enabled: true };

      const session = await stripeClient.checkout.sessions.create(params);
      res.status(200).json({ url: session.url, id: session.id });
    } catch (err) {
      next(err);
    }
  };
}

function buildPortalHandler({ stripeClient, userModel, log, errors }) {
  const { ValidationError, ForbiddenError } = errors;
  return async function portalHandler(req, res, next) {
    try {
      const refused = refuseClientAuth(req.user);
      if (refused) return next(new ForbiddenError(refused.message));

      const { returnUrl } = req.body || {};
      if (!returnUrl) return next(new ValidationError('returnUrl is required'));

      const customerId = await getOrCreateCustomer({
        stripeClient,
        userModel,
        user: req.user,
        log,
      });

      const session = await stripeClient.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      res.status(200).json({ url: session.url });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { buildCheckoutHandler, buildPortalHandler, refuseClientAuth };
