const { createLocalDriver } = require('./local');

let cached = null;

/**
 * Pick a storage driver based on STORAGE_DRIVER env var. Defaults to
 * 'local'. The result is cached so multiple imports / handlers share
 * one instance (S3 client connection pool, etc.).
 *
 * Tests can pass an explicit `override` to bypass env-driven selection.
 */
function getStorageDriver(override) {
  if (override) {
    cached = override;
    return cached;
  }
  if (cached) return cached;
  const driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  if (driver === 's3') {
    const { createS3Driver } = require('./s3');
    cached = createS3Driver();
  } else {
    cached = createLocalDriver();
  }
  return cached;
}

function resetStorageDriver() {
  cached = null;
}

module.exports = { getStorageDriver, resetStorageDriver, createLocalDriver };
