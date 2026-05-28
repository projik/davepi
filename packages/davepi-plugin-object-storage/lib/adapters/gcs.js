'use strict';

/**
 * Google Cloud Storage adapter.
 *
 * GCS exposes a presigned-URL surface ("V4 signed URLs") but with a
 * different SDK + auth model than S3 — there's no drop-in shim. Hence
 * a real adapter file rather than a parameterised aws.js variant.
 *
 * `@google-cloud/storage` is declared as an `optionalDependencies` so a
 * consumer who doesn't run GCS doesn't have to install it. The require
 * is wrapped — if the package isn't on the path, the plugin throws a
 * clear "set S3_BACKEND=aws or install @google-cloud/storage" message
 * at setup time rather than crashing with a cryptic MODULE_NOT_FOUND
 * mid-request.
 */

function createGcsAdapter(config, { sdkOverride } = {}) {
  const sdk = sdkOverride || loadSdk();
  if (!sdk) {
    throw new Error(
      'davepi-plugin-object-storage (gcs adapter): @google-cloud/storage is not installed. ' +
      'Add it to your dependencies, or set S3_BACKEND to aws / r2 / minio.'
    );
  }
  const { Storage } = sdk;

  if (!config.bucket) {
    throw new Error('davepi-plugin-object-storage (gcs adapter): S3_BUCKET is required');
  }

  const storageOpts = {};
  if (config.gcsProjectId) storageOpts.projectId = config.gcsProjectId;
  if (config.gcsKeyFile)   storageOpts.keyFilename = config.gcsKeyFile;
  const client = new Storage(storageOpts);
  const bucket = client.bucket(config.bucket);

  async function getSignedPutUrl({ key, contentType, expires }) {
    const [url] = await bucket.file(key).getSignedUrl({
      version:     'v4',
      action:      'write',
      expires:     Date.now() + expires * 1000,
      contentType,
    });
    return url;
  }

  async function getSignedGetUrl({ key, expires }) {
    const [url] = await bucket.file(key).getSignedUrl({
      version: 'v4',
      action:  'read',
      expires: Date.now() + expires * 1000,
    });
    return url;
  }

  async function headObject({ key }) {
    try {
      const [metadata] = await bucket.file(key).getMetadata();
      const size = metadata && (metadata.size || metadata.Size);
      return {
        exists:        true,
        contentLength: size != null ? Number(size) : null,
        contentType:   (metadata && (metadata.contentType || metadata.ContentType)) || null,
        etag:          (metadata && (metadata.etag || metadata.Etag)) || null,
      };
    } catch (err) {
      if (err && (err.code === 404 || err.statusCode === 404)) {
        return { exists: false };
      }
      throw err;
    }
  }

  async function deleteObject({ key }) {
    await bucket.file(key).delete({ ignoreNotFound: true });
  }

  function publicUrl({ key }) {
    if (config.publicBaseUrl) {
      return `${config.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
    }
    return `https://storage.googleapis.com/${config.bucket}/${key}`;
  }

  return {
    name:   'gcs',
    bucket: config.bucket,
    getSignedPutUrl,
    getSignedGetUrl,
    headObject,
    deleteObject,
    publicUrl,
    _client: client,
  };
}

function loadSdk() {
  try {
    return require('@google-cloud/storage');
  } catch (_err) {
    return null;
  }
}

module.exports = { createGcsAdapter };
