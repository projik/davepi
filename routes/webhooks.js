const express = require('express');
const Webhook = require('../model/webhook');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { emitRecordEvent } = require('../utils/events');
const { generateSecret } = require('../utils/webhookDispatcher');
const { validateWebhookUrl } = require('../utils/urlValidator');

const router = express.Router();

const sanitize = (sub) => {
  const obj = sub.toObject ? sub.toObject() : sub;
  // Never echo the secret on read paths — caller already saw it once
  // at create time.
  const { secret, __v, ...rest } = obj;
  return rest;
};

router.post(
  '/api/v1/webhooks',
  auth(true),
  asyncHandler(async (req, res) => {
    const { events, url } = req.body || {};
    if (!Array.isArray(events) || events.length === 0) {
      throw new ValidationError('events must be a non-empty array');
    }
    if (typeof url !== 'string') {
      throw new ValidationError('url must be a string');
    }
    // SSRF defense: reject loopback / private / link-local targets and
    // hostnames that resolve to those. Test mode allows them so the
    // suite's local express receiver (bound to 127.0.0.1) keeps working.
    try {
      await validateWebhookUrl(url, {
        allowPrivate: process.env.NODE_ENV === 'test',
      });
    } catch (e) {
      throw new ValidationError(e.message);
    }
    const secret = generateSecret();
    const sub = await Webhook.create({
      userId: req.user.user_id,
      events,
      url,
      secret,
    });
    // Return the secret exactly once at create time. Subsequent reads
    // never include it.
    res.status(201).json({ ...sanitize(sub), secret });
  })
);

router.get(
  '/api/v1/webhooks',
  auth(true),
  asyncHandler(async (req, res) => {
    const subs = await Webhook.find({ userId: req.user.user_id }).sort({ createdAt: -1 });
    res.status(200).json({ results: subs.map(sanitize) });
  })
);

router.get(
  '/api/v1/webhooks/:id',
  auth(true),
  asyncHandler(async (req, res) => {
    const sub = await Webhook.findOne({
      _id: req.params.id,
      userId: req.user.user_id,
    });
    if (!sub) throw new NotFoundError('webhook');
    res.status(200).json(sanitize(sub));
  })
);

router.delete(
  '/api/v1/webhooks/:id',
  auth(true),
  asyncHandler(async (req, res) => {
    const result = await Webhook.deleteOne({
      _id: req.params.id,
      userId: req.user.user_id,
    });
    if (!result.deletedCount) throw new NotFoundError('webhook');
    res.status(204).end();
  })
);

router.post(
  '/api/v1/webhooks/:id/test',
  auth(true),
  asyncHandler(async (req, res) => {
    const sub = await Webhook.findOne({
      _id: req.params.id,
      userId: req.user.user_id,
    });
    if (!sub) throw new NotFoundError('webhook');
    const dispatcher = req.app.locals.webhookDispatcher;
    if (!dispatcher) throw new NotFoundError('dispatcher');
    // Hand-fire one delivery, bypassing the bus pattern match — the
    // test endpoint should always reach the targeted sub regardless
    // of its `events` filter. Caller gets 202 immediately; success or
    // failure shows up on the subscription's failureCount field.
    dispatcher.dispatchOne(sub._id, {
      type: 'webhook.test',
      userId: String(req.user.user_id),
      version: 'v1',
      record: { triggeredBy: String(req.user.user_id), at: new Date().toISOString() },
    });
    res.status(202).json({ queued: true });
  })
);

module.exports = router;
