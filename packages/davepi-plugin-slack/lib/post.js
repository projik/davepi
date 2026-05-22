'use strict';

/**
 * POST a message body to a Slack incoming-webhook URL. Returns the
 * response's status code on success; throws on transport error,
 * timeout, or non-2xx status (Slack returns `ok` on the body and a
 * status code, but treats `200 + invalid_payload` text the same as
 * an HTTP error — we surface either as a throw so the caller can
 * decide whether to log-and-swallow or propagate).
 *
 * `fetchImpl` is injectable so tests don't have to monkey-patch the
 * global. Node 18+ has `fetch` built in; this package's
 * `engines.node` pins it.
 */
async function post(fetchImpl, url, body, { timeoutMs = 10000 } = {}) {
  if (!fetchImpl) {
    throw new Error('davepi-plugin-slack: fetch is not available (Node 18+ required)');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response || !response.ok) {
    const status = response && response.status;
    // Slack's error body is plain text ("invalid_payload",
    // "channel_not_found", ...); include it so operators can act.
    let text = '';
    try { text = response && typeof response.text === 'function' ? await response.text() : ''; } catch (_) { /* ignore */ }
    const err = new Error(`Slack POST failed (status ${status || 'unknown'}): ${text || 'no body'}`);
    err.status = status;
    err.responseBody = text;
    throw err;
  }
  return response.status;
}

module.exports = { post };
