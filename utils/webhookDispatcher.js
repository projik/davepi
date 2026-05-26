const crypto = require('crypto');
const Webhook = require('../model/webhook');
const { bus } = require('./events');
const logger = require('./logger');

/**
 * Default backoff schedule (1s, 5s, 30s, 5m, 1h). After this list is
 * exhausted the delivery is given up; once the subscription has
 * accumulated DEFAULT_MAX_FAILURES *consecutive* failed deliveries
 * the subscription is auto-disabled.
 */
const DEFAULT_BACKOFF_MS = [1000, 5000, 30000, 5 * 60 * 1000, 60 * 60 * 1000];
const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Returns true if the subscription's `events` list matches the given
 * event type. Supported patterns:
 *   - exact: 'account.created'
 *   - resource wildcard: 'account.*'
 *   - global wildcard: '*'
 */
function eventMatches(subscriptionEvents, eventType) {
  if (!Array.isArray(subscriptionEvents)) return false;
  for (const pattern of subscriptionEvents) {
    if (pattern === '*') return true;
    if (pattern === eventType) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      if (eventType.startsWith(prefix + '.')) return true;
    }
  }
  return false;
}

const sign = (secret, body) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

const generateSecret = () => crypto.randomBytes(32).toString('hex');

/**
 * Start a webhook dispatcher attached to the shared event bus.
 * Returns a handle with `.stop()` to detach the listener and cancel
 * pending retries.
 *
 * Options accepted (all optional, defaults match the issue spec):
 *   - backoffMs:  number[] — schedule of retry delays in ms
 *   - maxFailures: number  — auto-disable threshold
 *   - timeoutMs:  number   — per-request timeout
 *   - fetch:      function — override fetch impl (tests inject)
 *   - now:        function — override Date.now (tests stub)
 */
function startWebhookDispatcher({
  backoffMs = DEFAULT_BACKOFF_MS,
  maxFailures = DEFAULT_MAX_FAILURES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetch: fetchImpl = global.fetch,
  log = logger,
} = {}) {
  const pendingTimers = new Set();

  async function deliver(subId, event, attempt) {
    // Always re-fetch the subscription so per-attempt state (active /
    // failureCount) is consistent with any concurrent updates.
    const sub = await Webhook.findById(subId);
    if (!sub || !sub.active) return;

    const id = crypto.randomUUID();
    const body = JSON.stringify({
      id,
      type: event.type,
      version: event.version,
      userId: event.userId,
      recordId: event.recordId,
      record: event.record,
      filter: event.filter,
      numAffected: event.numAffected,
      deliveredAt: new Date().toISOString(),
    });
    const signature = sign(sub.secret, body);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller && setTimeout(() => controller.abort(), timeoutMs);
    if (timer && timer.unref) timer.unref();

    let ok = false;
    let reason = null;
    try {
      const res = await fetchImpl(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-davepi-Signature': `sha256=${signature}`,
          'X-davepi-Event': event.type,
          'X-davepi-Delivery': id,
        },
        body,
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      ok = res && res.ok;
      if (!ok) reason = `HTTP ${res && res.status}`;
    } catch (err) {
      if (timer) clearTimeout(timer);
      reason = err && err.message ? err.message : String(err);
    }

    if (ok) {
      await Webhook.updateOne(
        { _id: sub._id },
        { $set: { failureCount: 0, lastDeliveryAt: new Date(), lastFailureReason: null } }
      );
      log.info({ subId: String(sub._id), type: event.type, attempt }, 'webhook delivered');
      return;
    }

    const newFailureCount = (sub.failureCount || 0) + 1;
    const shouldDisable = newFailureCount >= maxFailures;
    await Webhook.updateOne(
      { _id: sub._id },
      {
        $set: {
          failureCount: newFailureCount,
          lastFailureAt: new Date(),
          lastFailureReason: reason,
          ...(shouldDisable ? { active: false } : {}),
        },
      }
    );
    log.warn(
      {
        subId: String(sub._id),
        type: event.type,
        attempt,
        reason,
        newFailureCount,
        disabled: shouldDisable,
      },
      'webhook delivery failed'
    );

    if (shouldDisable) return;

    const delay = backoffMs[attempt];
    if (delay === undefined) {
      // Schedule exhausted for this delivery; the consecutive-failure
      // counter on the model handles the auto-disable.
      return;
    }

    const t = setTimeout(() => {
      pendingTimers.delete(t);
      // Best-effort retry: any exception inside deliver is caught and
      // logged; the framework owns the timer chain.
      deliver(subId, event, attempt + 1).catch((err) => {
        log.error({ err, subId: String(sub._id) }, 'webhook retry threw');
      });
    }, delay);
    if (t.unref) t.unref();
    pendingTimers.add(t);
  }

  async function onRecord(event) {
    if (!event || !event.type) return;
    // EventEmitter.emit() runs listeners synchronously and ignores
    // their return values, so an async listener like this one becomes
    // a detached promise the second it `await`s anything. Wrapping
    // every awaited path in try/catch keeps a transient infra failure
    // (Mongo disconnect, intermittent network blip, a test harness
    // shutting down between an emit and the resulting `find`) from
    // surfacing as an unhandledRejection that jest then attributes to
    // an unrelated test. Same posture every plugin bus subscriber
    // already follows.
    try {
      const subs = await Webhook.find({
        userId: event.userId,
        active: true,
      });
      for (const sub of subs) {
        if (eventMatches(sub.events, event.type)) {
          deliver(sub._id, event, 0).catch((err) => {
            log.error({ err, subId: String(sub._id) }, 'webhook initial dispatch threw');
          });
        }
      }
    } catch (err) {
      log.error({ err, type: event.type }, 'webhook dispatcher onRecord failed');
    }
  }

  bus.on('record', onRecord);

  return {
    /**
     * Hand-fire delivery to a single subscription, bypassing the bus
     * pattern match. Used by `POST /api/v1/webhooks/:id/test`.
     */
    dispatchOne(subId, event) {
      return deliver(subId, event, 0).catch((err) => {
        log.error({ err, subId: String(subId) }, 'webhook dispatchOne threw');
      });
    },
    stop() {
      bus.off('record', onRecord);
      for (const t of pendingTimers) clearTimeout(t);
      pendingTimers.clear();
    },
  };
}

module.exports = {
  startWebhookDispatcher,
  eventMatches,
  generateSecret,
  sign,
};
