'use strict';

/**
 * Adapter factory. Picks an adapter implementation based on the
 * config's `backend` ('aws' | 'r2' | 'minio' | 'gcs'). R2 and MinIO
 * share the AWS adapter — they speak the S3 wire protocol and only
 * differ via the `endpoint` override that readConfig already wired up.
 *
 * The factory accepts an optional `sdkOverrides` for tests: pass
 * `{ aws: { client, presigner }, gcs: { Storage } }` to swap the
 * underlying SDKs without touching the require graph.
 */

const { createAwsAdapter } = require('./aws');
const { createGcsAdapter } = require('./gcs');

function createAdapter(config, { sdkOverrides = {} } = {}) {
  switch (config.backend) {
    case 'gcs':
      return createGcsAdapter(config, { sdkOverride: sdkOverrides.gcs });
    case 'r2':
    case 'minio':
    case 'aws':
    default:
      return createAwsAdapter(config, { sdkOverride: sdkOverrides.aws });
  }
}

module.exports = { createAdapter, createAwsAdapter, createGcsAdapter };
