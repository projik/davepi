const express = require('express');
const fs = require('fs');
const path = require('path');
const { getStorageDriver } = require('../utils/storage');

const router = express.Router();

/**
 * Local-driver static-ish serve route. Public files (no `exp`/`sig`)
 * are served directly; private files require an HMAC-signed URL with
 * a valid expiry. The local driver's `signedUrl(key)` produces these
 * URLs; the same driver's `verifySignedRequest` validates them here.
 *
 * Only mounted when STORAGE_DRIVER=local. The s3 driver bypasses this
 * route entirely — its presigned URLs point at S3.
 */
router.get('/_files/*', (req, res, next) => {
  const storage = getStorageDriver();
  if (storage.name !== 'local' || !storage.streamPath) {
    return res.status(404).end();
  }

  // Express routes use a wildcard; req.params[0] is the rest of the
  // path. Decode and normalize to defend against traversal.
  const rawKey = req.params[0];
  const key = decodeURI(rawKey);
  if (key.includes('..')) return res.status(400).end();

  const exp = req.query.exp;
  const sig = req.query.sig;
  if (exp || sig) {
    if (!storage.verifySignedRequest(key, exp, sig)) {
      return res.status(403).end();
    }
  }

  const filePath = storage.streamPath(key);
  fs.stat(filePath, (err) => {
    if (err) return res.status(404).end();
    res.sendFile(path.resolve(filePath));
  });
});

module.exports = router;
