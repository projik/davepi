'use strict';

/**
 * Keep the `stripe_subscription` mirror collection in sync with the
 * subset of webhook events that carry subscription state.
 *
 * Events that touch subscriptions:
 *   - customer.subscription.created
 *   - customer.subscription.updated
 *   - customer.subscription.deleted
 *   - customer.subscription.paused / resumed (treated as updates)
 *   - invoice.* — ignored here; invoice events don't change
 *     subscription identity, only payment status. Consumers that
 *     care can subscribe to the bus directly.
 *
 * userId resolution: every persisted mirror row needs a `userId` for
 * tenant isolation. We resolve it by looking up the User document
 * whose `stripeCustomerId` matches `subscription.customer`. If no
 * user is linked, we **don't persist** — log a warning. The
 * commonest cause is a webhook for a customer that was created
 * outside the framework (manually in the Stripe dashboard) and
 * hasn't been linked to a dAvePi user yet.
 */

const SUBSCRIPTION_EVENT_PREFIX = 'customer.subscription.';

function pickPriceId(subscription) {
  const item = subscription
    && subscription.items
    && subscription.items.data
    && subscription.items.data[0];
  return item && item.price && item.price.id;
}

function pickProductId(subscription) {
  const item = subscription
    && subscription.items
    && subscription.items.data
    && subscription.items.data[0];
  return item && item.price && item.price.product;
}

function toDate(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return null;
  return new Date(epochSeconds * 1000);
}

async function syncSubscriptionFromEvent({ event, models, log }) {
  if (!event || typeof event.type !== 'string') return;
  if (!event.type.startsWith(SUBSCRIPTION_EVENT_PREFIX)) return;

  const subscription = event.data && event.data.object;
  if (!subscription || !subscription.id || !subscription.customer) {
    log.warn(
      { plugin: 'stripe', eventId: event.id, eventType: event.type },
      'subscription sync: event missing subscription / customer id'
    );
    return;
  }

  const userDoc = await models.user.findOne({ stripeCustomerId: subscription.customer })
    .select('_id')
    .lean();
  if (!userDoc) {
    log.warn(
      {
        plugin: 'stripe',
        eventId: event.id,
        stripeCustomerId: subscription.customer,
      },
      'subscription sync: no linked dAvePi user for Stripe customer; skipping mirror write'
    );
    return;
  }

  const fields = {
    userId: String(userDoc._id),
    stripeCustomerId: subscription.customer,
    subscriptionId: subscription.id,
    status: subscription.status,
    priceId: pickPriceId(subscription),
    productId: pickProductId(subscription),
    currentPeriodStart: toDate(subscription.current_period_start),
    currentPeriodEnd: toDate(subscription.current_period_end),
    cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
    canceledAt: toDate(subscription.canceled_at),
    raw: subscription,
  };

  await models.subscription.findOneAndUpdate(
    { subscriptionId: subscription.id },
    { $set: fields },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  log.info(
    {
      plugin: 'stripe',
      subscriptionId: subscription.id,
      status: subscription.status,
      eventType: event.type,
    },
    'subscription mirror synced'
  );
}

module.exports = { syncSubscriptionFromEvent };
