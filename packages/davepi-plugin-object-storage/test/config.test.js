'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readConfig,
  mimeAllowed,
  parseBool,
  parseInteger,
  parseList,
  normalizePrefix,
  validateUploadRequest,
  DEFAULTS,
} = require('../lib/config');

class FakeValidationError extends Error {
  constructor(m) { super(m); this.code = 'VALIDATION'; }
}
const fakeErrors = { ValidationError: FakeValidationError };

test('readConfig: empty env yields defaults + null bucket (dormant signal)', () => {
  const c = readConfig({});
  assert.equal(c.backend, 'aws');
  assert.equal(c.bucket, null);
  assert.equal(c.putUrlTtlSeconds, DEFAULTS.putUrlTtlSeconds);
  assert.equal(c.getUrlTtlSeconds, DEFAULTS.getUrlTtlSeconds);
  assert.equal(c.maxBytes, DEFAULTS.maxBytes);
  assert.deepEqual(c.allowedMime, []);
  assert.equal(c.cascadeDelete, false);
  assert.equal(c.filePath, 'file');
  assert.equal(c.routePrefix, '/api/files');
  assert.equal(c.reapEnabled, true);
  assert.equal(c.forcePathStyle, false);
});

test('readConfig: backend is lowercased + clamped to the known set', () => {
  assert.equal(readConfig({ S3_BACKEND: 'R2' }).backend, 'r2');
  assert.equal(readConfig({ S3_BACKEND: 'MinIO' }).backend, 'minio');
  assert.equal(readConfig({ S3_BACKEND: 'gcs' }).backend, 'gcs');
  // Unknown backends fall back to aws rather than crashing — operators
  // see the value in the boot log and can fix.
  assert.equal(readConfig({ S3_BACKEND: 'azure' }).backend, 'aws');
});

test('readConfig: MinIO defaults to force-path-style, others do not', () => {
  assert.equal(readConfig({ S3_BACKEND: 'minio' }).forcePathStyle, true);
  assert.equal(readConfig({ S3_BACKEND: 'aws' }).forcePathStyle, false);
  // Explicit override wins.
  assert.equal(
    readConfig({ S3_BACKEND: 'aws', S3_FORCE_PATH_STYLE: 'true' }).forcePathStyle,
    true
  );
});

test('readConfig: integer parsing clamps to ≥ min', () => {
  assert.equal(
    readConfig({ S3_PUT_URL_TTL_SECONDS: 'abc' }).putUrlTtlSeconds,
    DEFAULTS.putUrlTtlSeconds
  );
  assert.equal(readConfig({ S3_PUT_URL_TTL_SECONDS: '60' }).putUrlTtlSeconds, 60);
  assert.equal(
    readConfig({ S3_REAP_INTERVAL_MS: '500' }).reapIntervalMs,
    DEFAULTS.reapIntervalMs
  );
});

test('readConfig: MIME allowlist splits and trims', () => {
  assert.deepEqual(
    readConfig({ S3_ALLOWED_MIME: 'image/png, image/jpeg ,application/pdf' }).allowedMime,
    ['image/png', 'image/jpeg', 'application/pdf']
  );
  assert.deepEqual(readConfig({ S3_ALLOWED_MIME: '' }).allowedMime, []);
});

test('readConfig: route prefix is normalised', () => {
  assert.equal(readConfig({ S3_ROUTE_PREFIX: 'api/files' }).routePrefix, '/api/files');
  assert.equal(readConfig({ S3_ROUTE_PREFIX: '/api/files/' }).routePrefix, '/api/files');
  assert.equal(readConfig({ S3_ROUTE_PREFIX: '/' }).routePrefix, '/');
});

test('mimeAllowed: empty allowlist accepts anything', () => {
  assert.equal(mimeAllowed('application/pdf', []), true);
  assert.equal(mimeAllowed('anything/at-all', []), true);
});

test('mimeAllowed: exact + wildcard subtype patterns', () => {
  assert.equal(mimeAllowed('image/png', ['image/png', 'application/pdf']), true);
  assert.equal(mimeAllowed('image/jpeg', ['image/png', 'application/pdf']), false);
  assert.equal(mimeAllowed('image/jpeg', ['image/*']), true);
  assert.equal(mimeAllowed('video/mp4', ['image/*']), false);
  // Case insensitive on both sides.
  assert.equal(mimeAllowed('IMAGE/PNG', ['image/png']), true);
});

test('mimeAllowed: non-string content type is rejected when allowlist set', () => {
  assert.equal(mimeAllowed(undefined, ['image/png']), false);
  assert.equal(mimeAllowed(null, ['image/png']), false);
  assert.equal(mimeAllowed('', ['image/png']), false);
});

test('parseBool / parseInteger / parseList primitives', () => {
  assert.equal(parseBool('TRUE', false), true);
  assert.equal(parseBool('no', true), false);
  assert.equal(parseBool('', true), true);
  assert.equal(parseBool('weird', true), true);

  assert.equal(parseInteger('42', 0), 42);
  assert.equal(parseInteger('0', 5, { min: 1 }), 5);
  assert.equal(parseInteger(null, 5), 5);

  assert.deepEqual(parseList('a, b, c'), ['a', 'b', 'c']);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(null), []);
});

test('normalizePrefix: handles missing leading slash + trailing slash', () => {
  assert.equal(normalizePrefix('files'), '/files');
  assert.equal(normalizePrefix('/files'), '/files');
  assert.equal(normalizePrefix('/files/'), '/files');
  assert.equal(normalizePrefix(''), '/api/files');
});

// Shared validator — same policy the REST route and the programmatic
// createUploadUrl both route through. PR #122 review fix.

test('validateUploadRequest: accepts a well-formed request', () => {
  validateUploadRequest({
    contentType: 'image/png',
    size:        1024,
    config:      { allowedMime: ['image/png'], maxBytes: 5000 },
    errors:      fakeErrors,
  });
  // No size is also OK — clients can omit it; the /complete HEAD check
  // catches the actual size against maxBytes server-side.
  validateUploadRequest({
    contentType: 'image/png',
    config:      { allowedMime: [], maxBytes: 5000 },
    errors:      fakeErrors,
  });
});

test('validateUploadRequest: requires non-empty contentType', () => {
  for (const bad of [undefined, null, '', 123, {}]) {
    assert.throws(
      () => validateUploadRequest({
        contentType: bad,
        config:      { allowedMime: [], maxBytes: 5000 },
        errors:      fakeErrors,
      }),
      /contentType is required/,
      `expected throw for contentType=${JSON.stringify(bad)}`
    );
  }
});

test('validateUploadRequest: enforces MIME allowlist', () => {
  assert.throws(
    () => validateUploadRequest({
      contentType: 'video/mp4',
      config:      { allowedMime: ['image/png', 'application/pdf'], maxBytes: 5000 },
      errors:      fakeErrors,
    }),
    /S3_ALLOWED_MIME/
  );
});

test('validateUploadRequest: enforces maxBytes when size declared', () => {
  assert.throws(
    () => validateUploadRequest({
      contentType: 'image/png',
      size:        10_000,
      config:      { allowedMime: [], maxBytes: 5000 },
      errors:      fakeErrors,
    }),
    /S3_MAX_BYTES/
  );
});

test('validateUploadRequest: rejects bogus size values', () => {
  for (const bad of ['abc', 0, -5, NaN, Infinity]) {
    assert.throws(
      () => validateUploadRequest({
        contentType: 'image/png',
        size:        bad,
        config:      { allowedMime: [], maxBytes: 5000 },
        errors:      fakeErrors,
      }),
      /size must be a positive number/,
      `expected throw for size=${bad}`
    );
  }
});
