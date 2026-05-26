'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAwsAdapter } = require('../lib/adapters/aws');

/**
 * Build an SDK stub that records every command + client option. Each
 * command class is just a tag; the stub `getSignedUrl` returns a
 * deterministic URL composed from the bucket + key so tests can assert
 * exactly what the presigner was asked to sign.
 */
function buildSdkStub() {
  const sent = [];
  const constructed = {};
  let lastClientOpts = null;

  const tagger = (tag) => class {
    constructor(input) {
      this.tag = tag;
      this.input = input;
    }
  };

  const stub = {
    client: {
      S3Client: class {
        constructor(opts) {
          lastClientOpts = opts;
          this.opts = opts;
          constructed.s3 = (constructed.s3 || 0) + 1;
        }
        async send(cmd) {
          sent.push(cmd);
          if (cmd.tag === 'Head' && cmd.input.Key === 'missing/key') {
            const err = new Error('NotFound');
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          if (cmd.tag === 'Head') {
            return { ContentLength: 12345, ContentType: 'image/png', ETag: '"abc"' };
          }
          return {};
        }
      },
      PutObjectCommand:    tagger('Put'),
      GetObjectCommand:    tagger('Get'),
      HeadObjectCommand:   tagger('Head'),
      DeleteObjectCommand: tagger('Delete'),
    },
    presigner: {
      getSignedUrl: async (_client, cmd, opts) => {
        return `https://stub.example/${cmd.input.Bucket}/${cmd.input.Key}?expires=${opts.expiresIn}&op=${cmd.tag}`;
      },
    },
    sent,
    lastClientOpts: () => lastClientOpts,
  };
  return stub;
}

test('createAwsAdapter: throws clearly when bucket is missing', () => {
  const sdk = buildSdkStub();
  assert.throws(
    () => createAwsAdapter({ backend: 'aws' }, { sdkOverride: sdk }),
    /S3_BUCKET is required/
  );
});

test('createAwsAdapter: passes credentials + region to the S3Client', () => {
  const sdk = buildSdkStub();
  createAwsAdapter(
    {
      backend:         'aws',
      bucket:          'b1',
      region:          'eu-west-1',
      accessKeyId:     'A',
      secretAccessKey: 'B',
      forcePathStyle:  false,
    },
    { sdkOverride: sdk }
  );
  const opts = sdk.lastClientOpts();
  assert.equal(opts.region, 'eu-west-1');
  assert.equal(opts.forcePathStyle, false);
  assert.deepEqual(opts.credentials, { accessKeyId: 'A', secretAccessKey: 'B' });
  assert.equal(opts.endpoint, undefined);
});

test('createAwsAdapter: omits credentials when env did not supply them (SDK default chain)', () => {
  const sdk = buildSdkStub();
  createAwsAdapter(
    { backend: 'aws', bucket: 'b1' },
    { sdkOverride: sdk }
  );
  // No credentials field at all — the SDK falls back to its default
  // chain (IRSA / EC2 metadata / shared config).
  assert.equal(sdk.lastClientOpts().credentials, undefined);
});

test('createAwsAdapter: MinIO mode passes endpoint + forcePathStyle', () => {
  const sdk = buildSdkStub();
  createAwsAdapter(
    {
      backend:        'minio',
      bucket:         'uploads',
      region:         'us-east-1',
      endpoint:       'http://minio:9000',
      forcePathStyle: true,
    },
    { sdkOverride: sdk }
  );
  const opts = sdk.lastClientOpts();
  assert.equal(opts.endpoint, 'http://minio:9000');
  assert.equal(opts.forcePathStyle, true);
});

test('getSignedPutUrl: requests a PutObject presign with contentType + expiry', async () => {
  const sdk = buildSdkStub();
  const adapter = createAwsAdapter(
    { backend: 'aws', bucket: 'b1', region: 'us-east-1' },
    { sdkOverride: sdk }
  );
  const url = await adapter.getSignedPutUrl({
    key:         'u/abc/file.png',
    contentType: 'image/png',
    expires:     300,
  });
  assert.match(url, /op=Put/);
  assert.match(url, /expires=300/);
  assert.match(url, /b1\/u\/abc\/file\.png/);
});

test('getSignedGetUrl: requests a GetObject presign with expiry', async () => {
  const sdk = buildSdkStub();
  const adapter = createAwsAdapter(
    { backend: 'aws', bucket: 'b1' },
    { sdkOverride: sdk }
  );
  const url = await adapter.getSignedGetUrl({ key: 'u/abc/x.png', expires: 600 });
  assert.match(url, /op=Get/);
  assert.match(url, /expires=600/);
});

test('headObject: returns the contentLength + contentType when the object exists', async () => {
  const sdk = buildSdkStub();
  const adapter = createAwsAdapter(
    { backend: 'aws', bucket: 'b1' },
    { sdkOverride: sdk }
  );
  const head = await adapter.headObject({ key: 'u/abc/x.png' });
  assert.equal(head.exists, true);
  assert.equal(head.contentLength, 12345);
  assert.equal(head.contentType, 'image/png');
  assert.equal(head.etag, '"abc"');
});

test('headObject: returns { exists: false } on 404, not a thrown error', async () => {
  const sdk = buildSdkStub();
  const adapter = createAwsAdapter(
    { backend: 'aws', bucket: 'b1' },
    { sdkOverride: sdk }
  );
  const head = await adapter.headObject({ key: 'missing/key' });
  assert.deepEqual(head, { exists: false });
});

test('deleteObject: issues a DeleteObjectCommand for the right bucket + key', async () => {
  const sdk = buildSdkStub();
  const adapter = createAwsAdapter(
    { backend: 'aws', bucket: 'b1' },
    { sdkOverride: sdk }
  );
  await adapter.deleteObject({ key: 'u/abc/x.png' });
  const last = sdk.sent[sdk.sent.length - 1];
  assert.equal(last.tag, 'Delete');
  assert.equal(last.input.Bucket, 'b1');
  assert.equal(last.input.Key, 'u/abc/x.png');
});

test('publicUrl: virtual-host-style by default, path-style with endpoint override', () => {
  const sdk = buildSdkStub();
  const aws = createAwsAdapter(
    { backend: 'aws', bucket: 'b1', region: 'eu-west-1' },
    { sdkOverride: sdk }
  );
  assert.equal(
    aws.publicUrl({ key: 'u/abc/x.png' }),
    'https://b1.s3.eu-west-1.amazonaws.com/u/abc/x.png'
  );

  const sdk2 = buildSdkStub();
  const minio = createAwsAdapter(
    { backend: 'minio', bucket: 'b1', endpoint: 'http://minio:9000', forcePathStyle: true },
    { sdkOverride: sdk2 }
  );
  assert.equal(
    minio.publicUrl({ key: 'u/abc/x.png' }),
    'http://minio:9000/b1/u/abc/x.png'
  );

  const sdk3 = buildSdkStub();
  const cdn = createAwsAdapter(
    { backend: 'r2', bucket: 'b1', endpoint: 'https://acct.r2.cloudflarestorage.com', publicBaseUrl: 'https://cdn.example.com' },
    { sdkOverride: sdk3 }
  );
  assert.equal(
    cdn.publicUrl({ key: 'u/abc/x.png' }),
    'https://cdn.example.com/u/abc/x.png'
  );
});
