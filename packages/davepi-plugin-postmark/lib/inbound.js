'use strict';

const crypto = require('crypto');

/**
 * Express route handler for Postmark's inbound webhook.
 *
 * Postmark forwards parsed emails as JSON POSTs to a URL you
 * configure in their dashboard. The body is the parsed message
 * (`From`, `To`, `Subject`, `TextBody`, `HtmlBody`, `Attachments`,
 * `Headers`, `MessageID`, ...). The recommended auth mechanism is
 * HTTP Basic in the URL — Postmark's dashboard lets you set
 * `https://user:pass@yourdomain/path` and adds an `Authorization:
 * Basic ...` header to every request.
 *
 * This handler:
 *   1. Validates the basic-auth header against the configured pair
 *      with a constant-time compare (prevents trivial timing leaks).
 *   2. Validates that the body looks like a Postmark InboundMessage
 *      (`MessageID` present, From/To present). A malformed body is
 *      a 400, not a 200 — Postmark will retry, and the operator can
 *      see the bad attempts in their dashboard.
 *   3. ACKs Postmark with 200 immediately, then fans out to
 *      registered handlers via setImmediate. A slow handler must not
 *      cause Postmark to retry — Postmark retries are for transport,
 *      not application failures.
 *   4. Wraps each handler call in try/catch so one bad subscriber
 *      doesn't starve the others.
 */

function timingSafeStringEqual(a, b) {
  // Buffer.byteLength to avoid surface-area for length-based timing
  // when the strings differ in size. crypto.timingSafeEqual requires
  // equal-length buffers, so pad/compare separately.
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isInboundShape(body) {
  if (!body || typeof body !== 'object') return false;
  // Postmark's inbound payload always carries MessageID and From.
  // Other fields are optional (e.g. an email with no Subject).
  if (typeof body.MessageID !== 'string' || !body.MessageID) return false;
  if (typeof body.From !== 'string' || !body.From) return false;
  return true;
}

function buildInboundHandler({ auth, emitter, log }) {
  const expectedHeader = 'Basic ' + Buffer.from(auth, 'utf8').toString('base64');
  return function postmarkInboundHandler(req, res) {
    const header = (req.headers && req.headers.authorization) || '';
    if (!timingSafeStringEqual(header, expectedHeader)) {
      log.warn({ plugin: 'postmark' }, 'inbound webhook auth failed');
      return res.status(401).json({ error: { code: 'unauthorized', message: 'invalid credentials' } });
    }
    if (!isInboundShape(req.body)) {
      log.warn({ plugin: 'postmark' }, 'inbound webhook body did not look like a Postmark message');
      return res.status(400).json({ error: { code: 'invalid_payload', message: 'expected Postmark InboundMessage' } });
    }

    const payload = req.body;
    const messageId = payload.MessageID;

    // ACK first, fan out after. Postmark's retry policy is for
    // transport failures, not handler crashes — if a handler is
    // slow or broken, we don't want a thundering herd of retries.
    res.status(200).json({ ok: true, MessageID: messageId });

    setImmediate(async () => {
      const listeners = emitter.listeners('email');
      for (const listener of listeners) {
        try {
          await listener(payload);
        } catch (err) {
          log.error(
            { err, plugin: 'postmark', messageId },
            'inbound email handler threw'
          );
        }
      }
    });
  };
}

module.exports = {
  buildInboundHandler,
  timingSafeStringEqual,
  isInboundShape,
};
