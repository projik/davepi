const mongoose = require('mongoose');
const logger = require('./logger');
const { fileFieldsOf } = require('./fileFields');
const { getStorageDriver } = require('./storage');

/**
 * Hard-delete soft-deleted records older than the retention window.
 * The default window is 30 days, configurable per-schema via
 * `softDelete: { retentionDays: N }` or globally via the env var
 * SOFT_DELETE_RETENTION_DAYS.
 *
 * For schemas that have File fields, this sweep also removes the
 * stored blobs before deleting the document — otherwise retention
 * would silently orphan storage objects, breaking parity with the
 * cascade behavior of the HTTP DELETE handler.
 *
 * Returns a per-resource summary `{ resource: deletedCount }` for
 * test assertions and operator visibility.
 */
async function purgeExpiredSoftDeletes(loader) {
  if (!loader || typeof loader.listSchemas !== 'function') return {};
  const summary = {};
  const now = Date.now();
  const storage = getStorageDriver();

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
    const fileFields = fileFieldsOf(s);
    const filter = { deletedAt: { $lt: cutoff, $ne: null } };
    try {
      if (fileFields.length) {
        // Fetch the doomed docs first so we can pull each File field's
        // key out and remove the blob from storage before deleting the
        // record. Project only the File fields plus _id to keep the
        // round-trip small.
        const projection = { _id: 1 };
        for (const ff of fileFields) projection[ff.name] = 1;
        const expiring = await Model.find(filter, projection).lean();
        for (const doc of expiring) {
          for (const ff of fileFields) {
            const meta = doc[ff.name];
            if (meta && meta.key) {
              try {
                await storage.remove(meta.key);
              } catch (err) {
                logger.warn(
                  { err, schema: key, key: meta.key },
                  'retention: blob remove failed; orphan left in storage'
                );
              }
            }
          }
        }
      }
      const result = await Model.deleteMany(filter);
      summary[s.path] = result.deletedCount || 0;
    } catch (err) {
      logger.error({ err, schema: key }, 'purge sweep failed for resource');
    }
  }
  return summary;
}

module.exports = { purgeExpiredSoftDeletes };
