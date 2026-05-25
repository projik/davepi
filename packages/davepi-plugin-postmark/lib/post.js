'use strict';

/**
 * POST a request body to a Postmark REST endpoint. Returns the
 * parsed JSON response on success (`{ ErrorCode: 0, MessageID, ... }`
 * for /email and /email/withTemplate; an array of those for the
 * /batch endpoints). Throws on transport error, timeout, non-2xx, or
 * a body shape that doesn't parse as JSON.
 *
 * Postmark uses a server token in the `X-Postmark-Server-Token`
 * header. The plugin reads it from env at boot and passes it in here
 * so this transport function stays auth-agnostic.
 *
 * Error shape: Postmark returns JSON like
 *   { "ErrorCode": 10, "Message": "Bad or missing API token" }
 * on 4xx. We surface `ErrorCode` and `Message` on the thrown Error so
 * operators can grep without re-parsing.
 */
async function post(fetchImpl, url, body, { serverToken, timeoutMs = 10000 } = {}) {
  if (!fetchImpl) {
    throw new Error('davepi-plugin-postmark: fetch is not available (Node 18+ required)');
  }
  if (!serverToken) {
    throw new Error('davepi-plugin-postmark: serverToken is required');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Don't pin the event loop: a short-running script (or test) that
  // exits before the fetch settles would otherwise wait the full
  // timeout. Mirrors utils/webhookDispatcher and the slack plugin.
  if (timer && typeof timer.unref === 'function') timer.unref();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Accept':                  'application/json',
        'Content-Type':            'application/json',
        'X-Postmark-Server-Token': serverToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  // Try to parse JSON regardless of status — Postmark uses JSON for
  // both success and failure bodies, and we want ErrorCode/Message
  // either way.
  let parsed = null;
  let rawText = '';
  try {
    rawText = typeof response.text === 'function' ? await response.text() : '';
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch (_) {
    // fall through; we'll surface rawText in the thrown error
  }

  if (!response.ok) {
    const status = response.status;
    const code = parsed && parsed.ErrorCode;
    const message = (parsed && parsed.Message) || rawText || 'no body';
    const err = new Error(
      `Postmark POST failed (status ${status}${code != null ? `, ErrorCode ${code}` : ''}): ${message}`
    );
    err.status = status;
    err.errorCode = code != null ? code : null;
    err.responseBody = parsed || rawText;
    throw err;
  }

  // Single-message endpoints return an object; batch endpoints return
  // an array of per-message results. Surface non-zero ErrorCode on
  // single-message responses as a thrown error so the caller doesn't
  // have to introspect — batch responses leave per-message inspection
  // to the caller (any of N may have failed independently).
  if (parsed && !Array.isArray(parsed) && typeof parsed.ErrorCode === 'number' && parsed.ErrorCode !== 0) {
    const err = new Error(
      `Postmark POST returned ErrorCode ${parsed.ErrorCode}: ${parsed.Message || 'unknown'}`
    );
    err.status = response.status;
    err.errorCode = parsed.ErrorCode;
    err.responseBody = parsed;
    throw err;
  }

  return parsed;
}

module.exports = { post };
