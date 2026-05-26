'use strict';

/**
 * Build the `file` schema the plugin registers with the framework's
 * schemaLoader. Once registered, the file collection is queryable
 * through every standard surface (REST list / read, GraphQL, MCP,
 * Swagger, the admin SPA) like any other dAvePi resource — but the
 * fields that describe where the bytes live are write-locked so
 * clients can't lie about them.
 *
 * Write-locked fields: `key`, `bucket`, `status`, `size`, `contentType`.
 * Anyone trying to POST or PUT these via the standard CRUD routes has
 * them filtered out by `filterWritable` (the sentinel ACL role no real
 * user holds — same trick `davepi-plugin-audit` uses on its `audit`
 * collection). The plugin's own upload-url / complete endpoints write
 * these directly via the Mongoose model, bypassing the API surface.
 *
 * `originalName` and `metadata` stay writable so a client can rename a
 * file or attach app-specific labels through the regular PUT route.
 *
 * The schema declares an `afterDelete` hook that talks to the storage
 * adapter when `S3_CASCADE_DELETE=true`. The hook is best-effort —
 * `after*` hooks already swallow throws per the framework contract, so
 * a transient bucket error logs but doesn't surface as a 5xx.
 */

function buildFileSchema({
  mongoose,
  errors,
  version,
  path,
  cascadeDelete,
  getAdapter,
  log,
}) {
  const Mixed = mongoose.Schema.Types.Mixed;
  const NO_ONE = ['__davepi_plugin_object_storage_only__'];
  const withWriteLock = (field) => ({
    ...field,
    acl: { ...(field.acl || {}), create: NO_ONE, update: NO_ONE },
  });

  const afterDelete = async ({ record }) => {
    if (!cascadeDelete) return;
    if (!record || !record.key) return;
    try {
      const adapter = getAdapter();
      if (!adapter) return;
      await adapter.deleteObject({ key: record.key });
    } catch (err) {
      // Best-effort: storage failure must not back-propagate into the
      // delete response. Same posture as audit's bus write — log via
      // the framework's pino instance and move on.
      if (log && typeof log.error === 'function') {
        log.error(
          { err, plugin: 'object-storage', key: record.key },
          'davepi-plugin-object-storage: cascade-delete of storage object failed'
        );
      }
    }
  };

  return {
    path,
    collection: path,
    version,
    // Soft-delete leaves the record around but the blob's still in the
    // bucket. Cascade-delete only runs on hard-delete (the framework's
    // afterDelete hook fires once per delete path; the soft-delete path
    // fires it with the tombstoned record, which we ignore unless the
    // hard-delete path runs). To keep semantics clean — and because file
    // records track an external mutable resource — `softDelete: false`
    // means the API always hard-deletes. Consumers who want a "trash"
    // workflow can layer their own status (`archived` etc.) on top.
    softDelete: false,
    fields: [
      withWriteLock({ name: 'userId',       type: String, required: true }),
      withWriteLock({ name: 'accountId',    type: String }),
      withWriteLock({ name: 'key',          type: String, required: true }),
      withWriteLock({ name: 'bucket',       type: String }),
      withWriteLock({ name: 'contentType',  type: String, required: true }),
      withWriteLock({ name: 'size',         type: Number }),
      withWriteLock({
        name:    'status',
        type:    String,
        enum:    ['pending', 'uploaded', 'deleted'],
        default: 'pending',
        required: true,
      }),
      { name: 'originalName', type: String },
      { name: 'metadata',     type: Mixed },
      withWriteLock({ name: 'uploadedAt',   type: Date }),
      withWriteLock({ name: 'etag',         type: String }),
    ],
    hooks: { afterDelete },
    // No `acl.list` bypass — files are tenant-scoped like every other
    // resource. Admins who need cross-tenant visibility can add a
    // schema override in their consumer project; the plugin's default
    // is the strict invariant.
  };
}

module.exports = { buildFileSchema };
