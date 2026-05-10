const mongoose = require('mongoose');

/**
 * Per-record audit log. One collection captures every mutation on
 * every schema-driven resource. The `resource` field stores the
 * schema's path (e.g., 'account', 'task'); paired with `recordId`
 * it identifies which document was touched.
 *
 * `before` and `after` snapshots are stored verbatim. `diff` is a
 * derived field of the form `{ fieldName: [from, to] }` for ease of
 * reading without reconstructing it from the snapshots.
 *
 * Audit entries are NEVER deleted by the framework. Schemas that
 * opt out via `audit: false` simply skip the recordAudit() call.
 */
const AuditLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    resource: { type: String, required: true, index: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    action: {
      type: String,
      enum: ['create', 'update', 'delete', 'restore', 'transition'],
      required: true,
    },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    diff: { type: mongoose.Schema.Types.Mixed, default: null },
    reqId: { type: String, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true }
);

AuditLogSchema.index({ resource: 1, recordId: 1, createdAt: -1 });

module.exports = mongoose.model('audit_log', AuditLogSchema);
