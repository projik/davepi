/**
 * S3 storage driver. Lazy-loads `@aws-sdk/client-s3` so the local
 * driver doesn't pay the cost when STORAGE_DRIVER=local (the default).
 *
 * Configuration is read from the environment at construction:
 *   - AWS_REGION (or S3_REGION)
 *   - S3_BUCKET
 *   - AWS credentials are picked up via the standard SDK chain
 *     (env vars, IRSA on EKS, EC2/ECS metadata).
 *   - S3_ENDPOINT (optional) for MinIO-compatible non-AWS endpoints.
 *
 * No tests run this end-to-end in CI (no S3 fixture). The module is
 * exercised by the storage factory smoke test.
 */
function createS3Driver({ bucket, region, endpoint } = {}) {
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
  } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const resolvedBucket = bucket || process.env.S3_BUCKET;
  const resolvedRegion =
    region || process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1';
  const resolvedEndpoint = endpoint || process.env.S3_ENDPOINT || undefined;

  if (!resolvedBucket) {
    throw new Error('S3 driver: S3_BUCKET env var is required');
  }

  const client = new S3Client({
    region: resolvedRegion,
    endpoint: resolvedEndpoint,
    forcePathStyle: !!resolvedEndpoint, // MinIO needs path-style
  });

  async function put(key, buffer, { contentType } = {}) {
    await client.send(
      new PutObjectCommand({
        Bucket: resolvedBucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
  }

  async function get(key) {
    const out = await client.send(
      new GetObjectCommand({ Bucket: resolvedBucket, Key: key })
    );
    // Body is a stream; collect to a Buffer.
    const chunks = [];
    for await (const chunk of out.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async function exists(key) {
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: resolvedBucket, Key: key })
      );
      return true;
    } catch (e) {
      if (e.$metadata && e.$metadata.httpStatusCode === 404) return false;
      throw e;
    }
  }

  async function remove(key) {
    await client.send(
      new DeleteObjectCommand({ Bucket: resolvedBucket, Key: key })
    );
  }

  async function signedUrl(key, { expiresInSeconds = 300 } = {}) {
    const cmd = new GetObjectCommand({ Bucket: resolvedBucket, Key: key });
    return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
  }

  function publicUrl(key) {
    if (resolvedEndpoint) return `${resolvedEndpoint}/${resolvedBucket}/${key}`;
    return `https://${resolvedBucket}.s3.${resolvedRegion}.amazonaws.com/${key}`;
  }

  function verifySignedRequest() {
    // S3 verifies its own presigned URLs; Express never serves S3
    // content directly.
    return true;
  }

  function streamPath() {
    throw new Error('S3 driver does not expose a local path');
  }

  return {
    name: 's3',
    put,
    get,
    exists,
    remove,
    signedUrl,
    publicUrl,
    verifySignedRequest,
    streamPath,
    bucket: resolvedBucket,
    region: resolvedRegion,
  };
}

module.exports = { createS3Driver };
