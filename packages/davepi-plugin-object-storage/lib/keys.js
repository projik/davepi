'use strict';

/**
 * Object-key generator. The shape is:
 *
 *   <userId>/<shortHash>/<safeOriginalName>
 *
 * The userId prefix means a flat `aws s3 ls` against the bucket
 * immediately tells an operator which tenant a key belongs to without
 * cross-referencing the DB. The 8-hex-char `shortHash` block prevents
 * accidental collisions between two files a tenant uploads with the
 * same name, and isolates listing-by-prefix to per-file granularity.
 * The original name (slugified) trails so the storage layer's
 * Content-Disposition can echo it back without extra DB work.
 *
 * The record `_id` remains the authoritative identifier; the key is
 * convenience-encoding for humans + log readers.
 */

const crypto = require('node:crypto');

const SAFE_NAME_RE = /[^a-zA-Z0-9._-]+/g;
const MAX_NAME_LEN = 128;

function slugifyName(name) {
  if (typeof name !== 'string' || !name) return 'file';
  // Strip any path component a careless client may have sent; Windows
  // backslashes and Unix slashes both get split, and we keep only the
  // basename. Then collapse whitespace + non-safe chars to underscore.
  const base = name.split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(SAFE_NAME_RE, '_').replace(/^_+|_+$/g, '');
  const truncated = cleaned.slice(0, MAX_NAME_LEN);
  return truncated || 'file';
}

function shortHash() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Build a fresh storage key for an upload. The `userId` is required —
 * the plugin's tenant-isolation invariant rests on every key carrying
 * its owner as the first path component.
 */
function buildKey({ userId, originalName }) {
  if (!userId) {
    throw new Error('buildKey requires userId');
  }
  return `${userId}/${shortHash()}/${slugifyName(originalName || 'file')}`;
}

/**
 * Extract the userId from a key, or `null` if the shape is unexpected.
 * Used by the cascade-delete subscriber to refuse to delete blobs whose
 * stored key disagrees with the record's `userId` (defence in depth: a
 * stamped record can't smuggle a foreign-tenant key past the storage
 * layer).
 */
function userIdOfKey(key) {
  if (typeof key !== 'string' || !key) return null;
  const slash = key.indexOf('/');
  if (slash < 1) return null;
  return key.slice(0, slash);
}

module.exports = {
  buildKey,
  slugifyName,
  userIdOfKey,
  shortHash,
};
