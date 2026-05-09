const { EventEmitter } = require('events');

/**
 * Process-local event bus for record lifecycle. Producers (REST and
 * GraphQL handlers) emit `record` events with shape:
 *
 *   { type: '<path>.<created|updated|deleted>',
 *     version: 'v1',
 *     userId: <ObjectId-string>,
 *     recordId: <ObjectId-string>,           // single-record events
 *     record: { ... },                        // single-record events
 *     filter: {...}, numAffected: N           // bulk events
 *   }
 *
 * Consumers (webhook dispatcher, future GraphQL subscriptions) attach
 * via bus.on('record', handler).
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

module.exports = { bus, emitRecordEvent };
