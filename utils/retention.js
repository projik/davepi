const mongoose = require('mongoose');
const logger = require('./logger');

/**
 * Hard-delete soft-deleted records older than the retention window.
 * The default window is 30 days, configurable per-schema via
 * `softDelete: { retentionDays: N }` or globally via the env var
 * SOFT_DELETE_RETENTION_DAYS.
 *
 * Returns a per-resource summary `{ resource: deletedCount }` for
 * test assertions and operator visibility.
 */
async function purgeExpiredSoftDeletes(loader) {
  if (!loader || typeof loader.listSchemas !== 'function') return {};
  const summary = {};
  const now = Date.now();

  for (const key of loader.listSchemas()) {
    const entry = loader.getEntry ? loader.getEntry(key) : null;
    if (!entry) continue;
    const s = entry.schema;
    if (s.softDelete === false) continue;
    const sdConfig = (s.softDelete && typeof s.softDelete === 'object') ? s.softDelete : {};
    const days =
      typeof sdConfig.retentionDays === 'number'
        ? sdConfig.retentionDays
        : parseInt(process.env.SOFT_DELETE_RETENTION_DAYS || '30', 10);
    if (!Number.isFinite(days) || days < 0) continue;

    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
    const Model = mongoose.models[s.collection];
    if (!Model) continue;
    try {
      const result = await Model.deleteMany({ deletedAt: { $lt: cutoff, $ne: null } });
      summary[s.path] = result.deletedCount || 0;
    } catch (err) {
      logger.error({ err, schema: key }, 'purge sweep failed for resource');
    }
  }
  return summary;
}

module.exports = { purgeExpiredSoftDeletes };
