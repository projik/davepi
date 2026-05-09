const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Local-disk file storage driver.
 *
 * Files live under UPLOADS_DIR (default ./uploads) at the key the
 * caller hands in. `signedUrl` returns an HMAC-signed URL that the
 * dispatch route validates against TOKEN_KEY — no static-file middleware
 * is registered globally, so private files can't be read by stumbling
 * onto a path.
 */
function createLocalDriver({ rootDir, tokenKey, baseUrl } = {}) {
  const root = path.resolve(rootDir || process.env.UPLOADS_DIR || './uploads');
  const secret = tokenKey || process.env.TOKEN_KEY || 'dev-only';

  async function ensureDir(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  function fullPath(key) {
    // Defend against path traversal. The key shouldn't contain `..`
    // segments — the framework generates keys, so this is belt-and-
    // suspenders.
    const safe = path.normalize(key).replace(/^(\.\.[/\\])+/g, '');
    return path.join(root, safe);
  }

  async function put(key, buffer) {
    const dest = fullPath(key);
    await ensureDir(dest);
    await fs.writeFile(dest, buffer);
  }

  async function get(key) {
    return fs.readFile(fullPath(key));
  }

  async function exists(key) {
    try {
      await fs.access(fullPath(key));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function remove(key) {
    try {
      await fs.unlink(fullPath(key));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  function signedUrl(key, { expiresInSeconds = 300 } = {}) {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = crypto
      .createHmac('sha256', secret)
      .update(`${key}.${exp}`)
      .digest('hex');
    const base = baseUrl || process.env.APP_URL || '';
    const params = new URLSearchParams({ exp: String(exp), sig });
    return `${base}/_files/${encodeURI(key)}?${params.toString()}`;
  }

  function verifySignedRequest(key, exp, sig) {
    if (!key || !exp || !sig) return false;
    const numExp = Number(exp);
    if (!Number.isFinite(numExp) || numExp < Math.floor(Date.now() / 1000)) {
      return false;
    }
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${key}.${numExp}`)
      .digest('hex');
    if (expected.length !== sig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  }

  function publicUrl(key) {
    const base = baseUrl || process.env.APP_URL || '';
    return `${base}/_files/${encodeURI(key)}`;
  }

  function streamPath(key) {
    return fullPath(key);
  }

  return {
    name: 'local',
    put,
    get,
    exists,
    remove,
    signedUrl,
    publicUrl,
    verifySignedRequest,
    streamPath,
    rootDir: root,
  };
}

module.exports = { createLocalDriver };
