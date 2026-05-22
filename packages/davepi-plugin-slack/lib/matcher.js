'use strict';

/**
 * Match a CRUD event type against a list of subscription patterns.
 * Supported forms:
 *   - exact:             'order.created'
 *   - resource wildcard: 'order.*'   matches order.created / order.updated / ...
 *   - global wildcard:   '*'         matches every event
 *
 * Kept in-package (a five-line copy of the framework's
 * `utils/webhookDispatcher.js#eventMatches`) so this plugin has zero
 * runtime dependency on davepi internals — only `davepi` as a
 * peerDependency, which is the consumer's install anyway.
 */
function eventMatches(patterns, eventType) {
  if (!Array.isArray(patterns) || !eventType) return false;
  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (pattern === eventType) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      if (eventType.startsWith(prefix + '.')) return true;
    }
  }
  return false;
}

module.exports = { eventMatches };
