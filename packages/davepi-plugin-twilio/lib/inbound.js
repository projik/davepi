'use strict';

/**
 * Twilio inbound SMS webhook handler.
 *
 * Twilio POSTs urlencoded form data to a URL you configure in the
 * console. We:
 *   1. Validate `X-Twilio-Signature` via `twilio.validateRequest`. The
 *      "full URL" must be the **public** URL — protocol + host + path
 *      + query — that Twilio was configured with, so the signature
 *      matches what Twilio computed.
 *   2. On mismatch: `next(new UnauthorizedError(...))`. The
 *      framework's `errorHandler` then surfaces the standard 401
 *      shape.
 *   3. On success: ACK 200 with the TwiML empty-response shape
 *      (`text/xml`, `<Response></Response>`) so Twilio is happy.
 *      Twilio retries on transport failures, not application errors —
 *      a slow or throwing subscriber would otherwise trigger a
 *      thundering herd of retries.
 *   4. Fan out via `setImmediate` to subscribers registered through
 *      the plugin's `onInboundSms(handler)`. Each handler is wrapped
 *      in try/catch so one bad subscriber doesn't starve the others.
 */

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function buildInboundHandler({ authToken, validateRequest, emitter, log, errors }) {
  if (!errors || typeof errors.UnauthorizedError !== 'function') {
    throw new Error(
      'davepi-plugin-twilio: buildInboundHandler requires errors.UnauthorizedError'
    );
  }
  const { UnauthorizedError } = errors;
  return function twilioInboundHandler(req, res, next) {
    const sig = (req.headers && (req.headers['x-twilio-signature'] || req.headers['X-Twilio-Signature'])) || '';
    const protocol = (req.headers && req.headers['x-forwarded-proto']) || req.protocol || 'https';
    const host = (req.headers && req.headers['x-forwarded-host']) || (req.get && req.get('host')) || (req.headers && req.headers.host) || '';
    const fullUrl = `${protocol}://${host}${req.originalUrl || req.url || ''}`;
    const params = req.body || {};

    let ok = false;
    try {
      ok = validateRequest(authToken, sig, fullUrl, params);
    } catch (err) {
      log && log.error && log.error({ err, plugin: 'twilio' }, 'twilio.validateRequest threw');
      ok = false;
    }
    if (!ok) {
      log && log.warn && log.warn({ plugin: 'twilio' }, 'inbound SMS signature mismatch');
      return next(new UnauthorizedError('invalid Twilio signature'));
    }

    // ACK with TwiML empty <Response/>. Twilio expects text/xml.
    res.set('Content-Type', 'text/xml');
    res.status(200).send(TWIML_EMPTY);

    setImmediate(async () => {
      const listeners = emitter.listeners('sms');
      for (const listener of listeners) {
        try {
          await listener(params);
        } catch (err) {
          log && log.error && log.error(
            { err, plugin: 'twilio', messageSid: params && params.MessageSid },
            'inbound SMS handler threw'
          );
        }
      }
    });
  };
}

/**
 * Tiny zero-dep urlencoded parser. Twilio inbound posts
 * `application/x-www-form-urlencoded`, but the framework's main app
 * mounts only `express.json()` globally. The handler is mounted with
 * this middleware in front so `req.body` is populated. We try
 * `express.urlencoded` first (the framework's express is in the
 * require path at runtime); on failure fall back to a
 * `URLSearchParams`-based parser that produces the same shape.
 */
function defaultUrlencodedParser() {
  try {
    const express = require('express');
    return express.urlencoded({ extended: false });
  } catch (_) {
    return function fallbackUrlencoded(req, res, next) {
      if (req.body && Object.keys(req.body).length) return next();
      const contentType = (req.headers && req.headers['content-type']) || '';
      if (!contentType.includes('application/x-www-form-urlencoded')) return next();
      let raw = '';
      req.setEncoding && req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const parsed = {};
        try {
          const usp = new URLSearchParams(raw);
          for (const [k, v] of usp.entries()) parsed[k] = v;
        } catch (_) {}
        req.body = parsed;
        next();
      });
      req.on('error', (err) => next(err));
    };
  }
}

module.exports = {
  buildInboundHandler,
  defaultUrlencodedParser,
  TWIML_EMPTY,
};
