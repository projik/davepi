const { EventEmitter } = require('events');

/**
 * Process-local event bus for record lifecycle. Producers (REST and
 * GraphQL handlers) emit `record` events with shape:
 *
 *   { type: '<path>.<created|updated|deleted|transitioned>',
 *     version: 'v1',
 *     userId: <ObjectId-string>,
 *     recordId: <ObjectId-string>,           // single-record events
 *     record: { ... },                        // single-record events (after)
 *     before: { ... },                        // single-record updates/deletes (when available)
 *     after:  { ... },                        // single-record creates/updates (when available)
 *     filter: {...}, numAffected: N,          // bulk events
 *     req: { ip, userAgent, reqId },          // request metadata (when emitted in HTTP scope)
 *   }
 *
 * `before` / `after` are populated by producers that already compute
 * them for the in-tree audit (`utils/audit.js`) — REST handlers always
 * have these in scope. GraphQL paths may set them when a `before`
 * fetch has already been done for hooks; non-HTTP producers (the MCP
 * tools, internal jobs) may omit `req` and `before` / `after`.
 * Consumers MUST tolerate any of these being absent.
 *
 * `req` is the narrow `{ ip, userAgent, reqId }` shape — never the
 * full Express `req` object — so log redaction and the
 * inactivity-of-the-record-bus contract aren't compromised by a
 * subscriber walking arbitrary request state.
 *
 * Consumers (webhook dispatcher, future GraphQL subscriptions,
 * davepi-plugin-audit) attach via bus.on('record', handler).
 *
 * setMaxListeners(0) disables the default 10-listener warning — the
 * webhook dispatcher attaches one listener and the framework grows
 * other consumers over time.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

const emitRecordEvent = (event) => {
  bus.emit('record', event);
};

/**
 * Build a redacted `{ ip, userAgent, reqId }` snapshot from an Express
 * `req`. Returns `null` when no usable req is supplied. The full `req`
 * is deliberately NOT placed on bus events — consumers should only see
 * this narrow shape so a subscriber can't reach into the rest of the
 * request state (body, headers, etc.) by accident.
 */
const buildReqMeta = (req) => {
  if (!req) return null;
  const ip = req.ip || null;
  const userAgent =
    (req.get && req.get('user-agent')) ||
    (req.headers && req.headers['user-agent']) ||
    null;
  const reqId = req.id ? String(req.id) : null;
  if (!ip && !userAgent && !reqId) return null;
  return { ip, userAgent, reqId };
};

module.exports = { bus, emitRecordEvent, buildReqMeta };
