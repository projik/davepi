'use strict';

/**
 * AWS S3 adapter — also used for Cloudflare R2 and MinIO via the
 * `endpoint` override. All three speak the same S3 wire protocol so
 * one client + one presigner cover them. The differences are:
 *
 *   - AWS:   no endpoint override, virtual-host-style URLs.
 *   - R2:    endpoint override to `https://<acct>.r2.cloudflarestorage.com`,
 *            virtual-host-style URLs supported.
 *   - MinIO: endpoint override to `http://<host>:9000`, MUST be
 *            path-style (the bucket sits in the URL path, not the host).
 *
 * `forcePathStyle` is the env knob; the readConfig default flips it on
 * for MinIO and off elsewhere, but operators can override per-deploy
 * for the rare bucket whose name isn't DNS-safe.
 *
 * The SDK is lazy-loaded so the gcs-only consumer doesn't pay the AWS
 * SDK cost. (`@aws-sdk/client-s3` and the presigner are still hard deps
 * of the plugin's package.json because the common case needs them; lazy
 * load is about runtime startup, not install footprint.)
 */

function createAwsAdapter(config, { sdkOverride } = {}) {
  const sdk = sdkOverride || loadSdk();
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
  } = sdk.client;
  const { getSignedUrl } = sdk.presigner;

  if (!config.bucket) {
    throw new Error('davepi-plugin-s3 (aws adapter): S3_BUCKET is required');
  }

  const region = config.region || 'us-east-1';
  const clientOpts = {
    region,
    forcePathStyle: !!config.forcePathStyle,
  };
  if (config.endpoint) clientOpts.endpoint = config.endpoint;
  if (config.accessKeyId && config.secretAccessKey) {
    clientOpts.credentials = {
      accessKeyId:     config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }
  // No credentials in env → fall through to the SDK's default credential
  // chain (IRSA on EKS, EC2/ECS metadata, ~/.aws/credentials). That's
  // intentional: hard-coded keys are the dev-machine path, IAM roles are
  // the production path, and the SDK handles both without our help.
  const client = new S3Client(clientOpts);

  async function getSignedPutUrl({ key, contentType, expires }) {
    const cmd = new PutObjectCommand({
      Bucket:      config.bucket,
      Key:         key,
      ContentType: contentType,
    });
    return getSignedUrl(client, cmd, { expiresIn: expires });
  }

  async function getSignedGetUrl({ key, expires }) {
    const cmd = new GetObjectCommand({ Bucket: config.bucket, Key: key });
    return getSignedUrl(client, cmd, { expiresIn: expires });
  }

  async function headObject({ key }) {
    try {
      const out = await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: key })
      );
      return {
        exists:        true,
        contentLength: typeof out.ContentLength === 'number' ? out.ContentLength : null,
        contentType:   out.ContentType || null,
        etag:          out.ETag || null,
      };
    } catch (err) {
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (status === 404 || (err && err.name === 'NotFound')) {
        return { exists: false };
      }
      throw err;
    }
  }

  async function deleteObject({ key }) {
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key })
    );
  }

  function publicUrl({ key }) {
    if (config.publicBaseUrl) {
      return `${config.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
    }
    if (config.endpoint) {
      // Path-style URL for endpoint-overridden providers; safe for both
      // R2's custom domain and MinIO's bare host.
      return `${config.endpoint.replace(/\/+$/, '')}/${config.bucket}/${key}`;
    }
    return `https://${config.bucket}.s3.${region}.amazonaws.com/${key}`;
  }

  return {
    name:    `aws:${config.backend}`,
    bucket:  config.bucket,
    region,
    getSignedPutUrl,
    getSignedGetUrl,
    headObject,
    deleteObject,
    publicUrl,
    _client: client, // exposed for advanced consumers via `plugin.adapter`
  };
}

function loadSdk() {
  // Lazy require so a project that only uses the gcs backend doesn't
  // execute the AWS SDK module graph at boot.
  return {
    client:    require('@aws-sdk/client-s3'),
    presigner: require('@aws-sdk/s3-request-presigner'),
  };
}

module.exports = { createAwsAdapter };
