'use strict';

/**
 * Parse env vars into a typed config object. All env-driven knobs live
 * here so the plugin's setup() doesn't litter parseInt / parseBool /
 * split-on-comma at the call sites.
 */

const DEFAULTS = {
  backend:           'aws',
  putUrlTtlSeconds:  300,
  getUrlTtlSeconds:  600,
  maxBytes:          50 * 1024 * 1024, // 50 MiB
  filePath:          'file',
  fileVersion:       'v1',
  routePrefix:       '/api/files',
  cascadeDelete:     false,
  verifyOnComplete:  true,
  reapEnabled:       true,
  // The reaper sweeps `pending` records that are older than the
  // presigned PUT URL's lifetime by a wide margin. The default 3× multiplier
  // gives clients comfortable headroom for slow networks (a 5-minute URL
  // means 15-minute orphan retention) without keeping garbage indefinitely.
  reapMultiplier:    3,
  reapIntervalMs:    5 * 60 * 1000,
};

const BACKENDS = new Set(['aws', 'r2', 'minio', 'gcs']);

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseInteger(raw, fallback, { min = 1 } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

function parseList(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read the plugin's full env-driven config. Operators can also override
 * any field by passing the same shape into `createPlugin({ env })`; the
 * default export reads `process.env` so unconfigured projects can list
 * the plugin in `davepi.plugins` and still boot.
 */
function readConfig(env = process.env) {
  const backendRaw = (env.S3_BACKEND || DEFAULTS.backend).toLowerCase();
  const backend = BACKENDS.has(backendRaw) ? backendRaw : DEFAULTS.backend;

  return {
    backend,
    bucket:             env.S3_BUCKET || null,
    region:             env.S3_REGION || env.AWS_REGION || null,
    endpoint:           env.S3_ENDPOINT || null,
    accessKeyId:        env.S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || null,
    secretAccessKey:    env.S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || null,
    forcePathStyle:     parseBool(env.S3_FORCE_PATH_STYLE, backend === 'minio'),
    publicBaseUrl:      env.S3_PUBLIC_BASE_URL || null,
    putUrlTtlSeconds:   parseInteger(env.S3_PUT_URL_TTL_SECONDS, DEFAULTS.putUrlTtlSeconds),
    getUrlTtlSeconds:   parseInteger(env.S3_GET_URL_TTL_SECONDS, DEFAULTS.getUrlTtlSeconds),
    maxBytes:           parseInteger(env.S3_MAX_BYTES, DEFAULTS.maxBytes),
    allowedMime:        parseList(env.S3_ALLOWED_MIME),
    cascadeDelete:      parseBool(env.S3_CASCADE_DELETE, DEFAULTS.cascadeDelete),
    verifyOnComplete:   parseBool(env.S3_VERIFY_ON_COMPLETE, DEFAULTS.verifyOnComplete),
    filePath:           env.S3_FILE_PATH || DEFAULTS.filePath,
    fileVersion:        env.S3_FILE_VERSION || DEFAULTS.fileVersion,
    routePrefix:        normalizePrefix(env.S3_ROUTE_PREFIX || DEFAULTS.routePrefix),
    reapEnabled:        parseBool(env.S3_REAP_ENABLED, DEFAULTS.reapEnabled),
    reapMultiplier:     parseInteger(env.S3_REAP_MULTIPLIER, DEFAULTS.reapMultiplier),
    reapIntervalMs:     parseInteger(env.S3_REAP_INTERVAL_MS, DEFAULTS.reapIntervalMs, { min: 1000 }),
    gcsProjectId:       env.GCS_PROJECT_ID || null,
    gcsKeyFile:         env.GCS_KEY_FILE || null,
  };
}

function normalizePrefix(p) {
  if (typeof p !== 'string' || !p) return DEFAULTS.routePrefix;
  let out = p.startsWith('/') ? p : `/${p}`;
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Verify the contentType passes the configured allowlist. An empty
 * allowlist means "any". The wildcard form `image/*` matches every
 * subtype the way standard Accept-headers expect.
 */
function mimeAllowed(contentType, allowedMime) {
  if (!Array.isArray(allowedMime) || allowedMime.length === 0) return true;
  if (typeof contentType !== 'string' || !contentType) return false;
  const ct = contentType.toLowerCase();
  for (const pat of allowedMime) {
    const p = pat.toLowerCase();
    if (p === ct) return true;
    if (p.endsWith('/*')) {
      const prefix = p.slice(0, -2);
      if (ct.startsWith(`${prefix}/`)) return true;
    }
  }
  return false;
}

/**
 * Validate a presigned-upload request against the configured policy.
 * Throws via the supplied `errors.ValidationError` on first failure;
 * returns void on success. Both the REST `POST /upload-url` handler
 * and the programmatic `createUploadUrl` route their input through
 * this so the policy is enforced uniformly — a consumer who calls the
 * programmatic API from a hook can't bypass the MIME allowlist or the
 * max-bytes gate that the route enforces.
 *
 * `errors` is the framework's `utils/errors` module (or a stub with
 * the same shape); passed in rather than required at module scope so
 * the package's own unit tests can run without `davepi` installed.
 */
function validateUploadRequest({ contentType, size, config, errors }) {
  const { ValidationError } = errors;
  if (typeof contentType !== 'string' || !contentType) {
    throw new ValidationError('contentType is required');
  }
  if (!mimeAllowed(contentType, config.allowedMime)) {
    throw new ValidationError(
      `contentType ${contentType} is not in S3_ALLOWED_MIME`
    );
  }
  if (size !== undefined && size !== null) {
    if (typeof size !== 'number' || size <= 0 || !Number.isFinite(size)) {
      throw new ValidationError('size must be a positive number');
    }
    if (size > config.maxBytes) {
      throw new ValidationError(
        `size ${size} exceeds S3_MAX_BYTES (${config.maxBytes})`
      );
    }
  }
}

module.exports = {
  DEFAULTS,
  BACKENDS,
  readConfig,
  parseBool,
  parseInteger,
  parseList,
  mimeAllowed,
  normalizePrefix,
  validateUploadRequest,
};
