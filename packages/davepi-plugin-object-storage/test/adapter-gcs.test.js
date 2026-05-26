'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGcsAdapter } = require('../lib/adapters/gcs');

/**
 * Build a `@google-cloud/storage`-shaped stub. Exposes the same
 * `Storage` class shape the adapter expects.
 */
function buildSdkStub({ failHead = false } = {}) {
  const sent = [];
  const Storage = class {
    constructor(opts) { this.opts = opts; }
    bucket(name) {
      this.lastBucketName = name;
      const file = (key) => ({
        getSignedUrl: async (opts) => {
          sent.push({ action: 'sign', key, opts });
          return [`https://stub.gcs/${name}/${key}?op=${opts.action}`];
        },
        getMetadata: async () => {
          if (failHead) {
            const err = new Error('not found');
            err.code = 404;
            throw err;
          }
          return [{ size: '4096', contentType: 'image/jpeg', etag: '"gcs-etag"' }];
        },
        delete: async (opts) => {
          sent.push({ action: 'delete', key, opts });
        },
      });
      return { file };
    }
  };
  return { Storage, sent };
}

test('createGcsAdapter: throws when @google-cloud/storage is not installed', () => {
  assert.throws(
    () =>
      createGcsAdapter(
        { backend: 'gcs', bucket: 'b' },
        { sdkOverride: null }
      ),
    /@google-cloud\/storage is not installed/
  );
});

test('createGcsAdapter: throws when bucket is missing', () => {
  const sdk = buildSdkStub();
  assert.throws(
    () => createGcsAdapter({ backend: 'gcs' }, { sdkOverride: sdk }),
    /S3_BUCKET is required/
  );
});

test('getSignedPutUrl: requests a v4 write signed URL with contentType + expires', async () => {
  const sdk = buildSdkStub();
  const adapter = createGcsAdapter(
    { backend: 'gcs', bucket: 'b', gcsProjectId: 'p', gcsKeyFile: '/tmp/k.json' },
    { sdkOverride: sdk }
  );
  const url = await adapter.getSignedPutUrl({
    key:         'u/abc/x.png',
    contentType: 'image/png',
    expires:     300,
  });
  assert.match(url, /op=write/);
  const call = sdk.sent[0];
  assert.equal(call.opts.version, 'v4');
  assert.equal(call.opts.action, 'write');
  assert.equal(call.opts.contentType, 'image/png');
  // expires is an absolute timestamp (ms) — verify it's roughly now+300s.
  const driftMs = Math.abs(call.opts.expires - (Date.now() + 300_000));
  assert.ok(driftMs < 2_000, `expected expires ≈ now+300s, drift was ${driftMs}ms`);
});

test('getSignedGetUrl: requests a v4 read signed URL', async () => {
  const sdk = buildSdkStub();
  const adapter = createGcsAdapter(
    { backend: 'gcs', bucket: 'b' },
    { sdkOverride: sdk }
  );
  const url = await adapter.getSignedGetUrl({ key: 'u/abc/x.png', expires: 600 });
  assert.match(url, /op=read/);
});

test('headObject: returns size + contentType from getMetadata', async () => {
  const sdk = buildSdkStub();
  const adapter = createGcsAdapter(
    { backend: 'gcs', bucket: 'b' },
    { sdkOverride: sdk }
  );
  const head = await adapter.headObject({ key: 'u/abc/x.png' });
  assert.equal(head.exists, true);
  assert.equal(head.contentLength, 4096);
  assert.equal(head.contentType, 'image/jpeg');
  assert.equal(head.etag, '"gcs-etag"');
});

test('headObject: returns { exists: false } on 404 from GCS', async () => {
  const sdk = buildSdkStub({ failHead: true });
  const adapter = createGcsAdapter(
    { backend: 'gcs', bucket: 'b' },
    { sdkOverride: sdk }
  );
  const head = await adapter.headObject({ key: 'u/missing/x.png' });
  assert.deepEqual(head, { exists: false });
});

test('deleteObject: passes ignoreNotFound so 404 is silent', async () => {
  const sdk = buildSdkStub();
  const adapter = createGcsAdapter(
    { backend: 'gcs', bucket: 'b' },
    { sdkOverride: sdk }
  );
  await adapter.deleteObject({ key: 'u/abc/x.png' });
  const call = sdk.sent[0];
  assert.equal(call.action, 'delete');
  assert.deepEqual(call.opts, { ignoreNotFound: true });
});

test('publicUrl: uses storage.googleapis.com by default, override with publicBaseUrl', () => {
  const sdk = buildSdkStub();
  const a = createGcsAdapter({ backend: 'gcs', bucket: 'b' }, { sdkOverride: sdk });
  assert.equal(
    a.publicUrl({ key: 'u/abc/x.png' }),
    'https://storage.googleapis.com/b/u/abc/x.png'
  );

  const sdk2 = buildSdkStub();
  const b = createGcsAdapter(
    { backend: 'gcs', bucket: 'b', publicBaseUrl: 'https://cdn.example/' },
    { sdkOverride: sdk2 }
  );
  assert.equal(b.publicUrl({ key: 'u/abc/x.png' }), 'https://cdn.example/u/abc/x.png');
});
