'use strict';

/**
 * Get-or-create Stripe customer linked to the calling dAvePi user.
 *
 * Called from both the checkout-session and portal-session paths.
 * The user's `stripeCustomerId` field on the User model is the
 * source of truth for the link: present → reuse, absent →
 * `stripe.customers.create({ ... })` and `findByIdAndUpdate` to
 * persist the new id.
 *
 * Race-safety: two concurrent first-hits from the same user could
 * create two Stripe customers. We use Stripe's `Idempotency-Key`
 * header keyed on the user id so a duplicate concurrent create
 * coalesces server-side at Stripe rather than minting two customer
 * rows. The local mirror still needs `findByIdAndUpdate(..., { new: true })`
 * with an atomic `$setOnInsert`-style guard; we accept the rare
 * possibility of a duplicate Stripe customer being created and
 * orphaned (the second concurrent caller will replace its
 * stripeCustomerId pointer to the most recent one). This is the
 * documented trade-off — auditable from Stripe's dashboard and
 * cheap to clean up.
 */

async function getOrCreateCustomer({ stripeClient, userModel, user, log, errors }) {
  const { ValidationError, NotFoundError } = errors || {};
  if (!user || !user.user_id) {
    if (ValidationError) throw new ValidationError('user.user_id is required');
    throw new Error('davepi-plugin-stripe: getOrCreateCustomer requires user.user_id');
  }
  const userDoc = await userModel.findById(user.user_id);
  if (!userDoc) {
    if (NotFoundError) throw new NotFoundError(`user ${user.user_id} not found`);
    throw new Error(`davepi-plugin-stripe: user ${user.user_id} not found`);
  }
  if (userDoc.stripeCustomerId) {
    return userDoc.stripeCustomerId;
  }

  const customer = await stripeClient.customers.create(
    {
      email: userDoc.email,
      metadata: { davepiUserId: String(userDoc._id) },
    },
    // Idempotency-Key collapses concurrent first-hits at Stripe.
    { idempotencyKey: `davepi-customer-${userDoc._id}` }
  );

  await userModel.findByIdAndUpdate(userDoc._id, { stripeCustomerId: customer.id });
  if (log && typeof log.info === 'function') {
    log.info(
      { plugin: 'stripe', userId: String(userDoc._id), stripeCustomerId: customer.id },
      'davepi-plugin-stripe: linked user to Stripe customer'
    );
  }
  return customer.id;
}

module.exports = { getOrCreateCustomer };
