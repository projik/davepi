'use strict';

/**
 * Build the audit-collection schema the plugin registers with the
 * framework's schemaLoader. The shape matches dAvePi's schema-driven
 * vocabulary (see AGENTS.md) so every standard surface — REST,
 * GraphQL, swagger, the `_describe` manifest — picks it up
 * automatically.
 *
 * Read-only-via-API is enforced at two layers:
 *
 *   1. Every field declares `acl.create` / `acl.update` whose value is
 *      a sentinel role no real user holds. `filterWritable` strips
 *      every key from inbound payloads, so an authenticated `POST` /
 *      `PUT` / bulk `PUT` lands an empty `$set` and writes nothing.
 *   2. `beforeCreate` / `beforeUpdate` / `beforeDelete` hooks throw
 *      `ForbiddenError`, surfacing a 403 on the REST single-record
 *      paths (and the equivalent GraphQL mutations, which route
 *      through the same hook runner).
 *
 * `acl.list = ['admin']` gives admins a cross-tenant bypass on read.
 * `acl.delete` is intentionally absent — combined with the
 * `beforeDelete` hook above, no caller (including admins, since the
 * bypass would only let them widen the owner predicate) can remove a
 * row through the standard CRUD surface.
 *
 * `audit: false` opts this schema OUT of the framework's in-tree
 * audit pipeline (`utils/audit.js`). The plugin's own bus subscriber
 * is what writes rows here; the in-tree pipeline writes to a separate
 * `audit_log` collection. Leaving the framework audit on would let
 * the (blocked) hook throws still leak audit_log rows.
 *
 * `softDelete: false` keeps this collection literal — no `deletedAt`
 * tombstone, no `/restore` route. The acceptance contract is
 * "append-only at the API layer", and a soft-deletable row still
 * presents as deletable to clients even when the underlying document
 * sticks around.
 */
function buildAuditSchema({ mongoose, version = 'v1', errors }) {
  const Mixed = mongoose.Schema.Types.Mixed;
  // A sentinel role no real user holds. `filterWritable` keeps fields
  // whose acl-allowed roles overlap the caller's roles; an opaque
  // marker guarantees the overlap check fails for every persona,
  // including admin.
  const NO_ONE = ['__davepi_audit_plugin_only__'];
  const withWriteLock = (field) => ({
    ...field,
    acl: { ...(field.acl || {}), create: NO_ONE, update: NO_ONE },
  });

  const { ForbiddenError } = errors;
  const blockWrite = (op) => async () => {
    throw new ForbiddenError(
      `audit log is append-only; ${op} not permitted via API ` +
        '(entries are written by davepi-plugin-audit only)'
    );
  };

  return {
    path: 'audit',
    collection: 'audit',
    version,
    softDelete: false,
    audit: false,
    fields: [
      withWriteLock({ name: 'userId',      type: String, required: true }),
      withWriteLock({ name: 'accountId',   type: String }),
      withWriteLock({ name: 'action',      type: String, required: true }),
      withWriteLock({ name: 'resource',    type: String, required: true }),
      withWriteLock({ name: 'resourceId',  type: String }),
      withWriteLock({ name: 'before',      type: Mixed }),
      withWriteLock({ name: 'after',       type: Mixed }),
      withWriteLock({ name: 'diff',        type: Mixed }),
      withWriteLock({ name: 'filter',      type: Mixed }),
      withWriteLock({ name: 'numAffected', type: Number }),
      withWriteLock({ name: 'ip',          type: String }),
      withWriteLock({ name: 'userAgent',   type: String }),
      withWriteLock({ name: 'reqId',       type: String }),
      withWriteLock({ name: 'at',          type: Date,   required: true }),
    ],
    acl: {
      // Admin role bypasses the owner-scoped read filter so compliance
      // reviewers see cross-tenant rows. Regular users see only the
      // rows whose `userId` matches their own — the standard tenant
      // invariant.
      list: ['admin'],
      // `delete` is deliberately omitted (no bypass). The hook below
      // is the actual block; the missing entry just keeps the bypass
      // story unambiguous.
    },
    hooks: {
      beforeCreate: blockWrite('create'),
      beforeUpdate: blockWrite('update'),
      beforeDelete: blockWrite('delete'),
    },
  };
}

module.exports = { buildAuditSchema };
