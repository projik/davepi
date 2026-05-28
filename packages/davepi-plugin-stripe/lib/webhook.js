'use strict';

/**
 * Express handler for `POST /api/webhooks/stripe`.
 *
 * Pipeline per request:
 *   1. Read raw body. The framework's global `express.json()` is
 *      configured with a `verify` callback that stashes the raw
 *      buffer on `req.rawBody`; that's the buffer we hand to
 *      `stripe.webhooks.constructEvent` — the SDK's helper handles
 *      the constant-time HMAC compare under the hood.
 *   2. Verify the `Stripe-Signature` header. Any failure (bad sig,
 *      replayed timestamp, malformed envelope) throws synchronously
 *      from `constructEvent`; we surface as 400 with no body. Stripe
 *      retries non-2xx, which is the correct behaviour for a real
 *      bad-signature situation (operator rotated the secret) — Stripe
 *      will keep retrying until the operator fixes the env.
 *   3. Insert the event id into `stripe_event_seen` with a 7d TTL.
 *      A duplicate-key error means we already processed this event;
 *      ACK 200 and short-circuit. Stripe retries failed deliveries,
 *      and we don't want to double-fire bus events.
 *   4. ACK Stripe with 200 immediately.
 *   5. Fan out the verified event onto the framework `bus` as
 *      `record` events typed `stripe.<event.type>`, **and** invoke
 *      any handlers registered via `onWebhookEvent(type, fn)` on the
 *      plugin instance. Both are best-effort: a thrown subscriber
 *      is logged but never triggers a Stripe retry, same posture as
 *      the postmark inbound plugin.
 *
 * Why dedupe-before-ACK rather than after: a deferred dedupe would
 * race two concurrent retries past the insert and fan out twice.
 * The dedupe row is the canonical signal that "this event has been
 * claimed for processing." If subsequent fan-out fails, an operator
 * can rerun via the Stripe dashboard's "Resend" button — which sends
 * a new event id, so the dedupe row doesn't block recovery.
 */

const { syncSubscriptionFromEvent } = require('./subscription');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isDuplicateKeyError(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

function buildWebhookHandler({
  stripeClient,
  webhookSecret,
  models,            // { eventSeen, subscription, user }
  bus,
  log,
  emitter,           // plugin-local EventEmitter for onWebhookEvent
}) {
  return async function stripeWebhookHandler(req, res) {
    const sigHeader = req.headers['stripe-signature'];
    if (!sigHeader) {
      log.warn({ plugin: 'stripe' }, 'webhook: missing Stripe-Signature header');
      return res.status(400).send('Missing Stripe-Signature');
    }
    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      log.error(
        { plugin: 'stripe' },
        'webhook: req.rawBody is not a Buffer — express.json() verify hook may not be wired'
      );
      return res.status(400).send('No raw body');
    }

    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.rawBody, sigHeader, webhookSecret);
    } catch (err) {
      log.warn(
        { plugin: 'stripe', err: { message: err.message } },
        'webhook: signature verification failed'
      );
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency dedupe. Insert first, ACK after — on duplicate-key
    // we know another (in-flight or completed) delivery already
    // claimed the event id and we short-circuit cleanly.
    try {
      await models.eventSeen.create({
        eventId: event.id,
        eventType: event.type,
        expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        log.info(
          { plugin: 'stripe', eventId: event.id, eventType: event.type },
          'webhook: duplicate event, short-circuiting'
        );
        return res.status(200).json({ received: true, duplicate: true });
      }
      log.error(
        { plugin: 'stripe', err, eventId: event.id },
        'webhook: dedupe insert failed — refusing event so Stripe retries'
      );
      return res.status(500).send('Dedupe insert failed');
    }

    // ACK first. Anything beyond this point is best-effort; a slow
    // subscriber must never trigger a Stripe retry. setImmediate
    // ensures the response has flushed before we run handlers.
    res.status(200).json({ received: true });

    setImmediate(async () => {
      // Sync the local subscription mirror for subscription.*
      // events. Failure is logged but doesn't break fan-out — the
      // bus subscribers still see the raw event.
      try {
        await syncSubscriptionFromEvent({
          event,
          models,
          log,
        });
      } catch (err) {
        log.error(
          { err, plugin: 'stripe', eventId: event.id, eventType: event.type },
          'webhook: subscription mirror sync failed'
        );
      }

      // Bus rebroadcast — every plugin subscriber (audit, slack,
      // postmark rules) can react to `stripe.*` events using the
      // same `record` event shape the framework already uses for
      // CRUD events. recordId is the Stripe object id when present
      // so downstream formatters render naturally.
      const stripeObject = event.data && event.data.object;
      try {
        bus.emit('record', {
          type: `stripe.${event.type}`,
          version: 'v1',
          recordId: stripeObject && stripeObject.id,
          record: stripeObject,
          eventId: event.id,
        });
      } catch (err) {
        log.error(
          { err, plugin: 'stripe', eventId: event.id },
          'webhook: bus emit failed'
        );
      }

      // Plugin-local subscribers registered via onWebhookEvent. We
      // iterate listeners for both the exact type and the global
      // `*` wildcard so a `*` subscriber sees every event.
      const channels = [event.type, '*'];
      for (const ch of channels) {
        const listeners = emitter.listeners(ch);
        for (const listener of listeners) {
          try {
            await listener(event);
          } catch (err) {
            log.error(
              { err, plugin: 'stripe', eventId: event.id, eventType: event.type },
              'webhook: subscriber threw'
            );
          }
        }
      }
    });
  };
}

module.exports = { buildWebhookHandler, isDuplicateKeyError };
