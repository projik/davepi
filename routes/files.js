const express = require('express');
const fs = require('fs');
const path = require('path');
const asyncHandler = require('../utils/asyncHandler');
const {
  NotFoundError,
  ValidationError,
  ForbiddenError,
} = require('../utils/errors');
const { getStorageDriver } = require('../utils/storage');

const router = express.Router();

/**
 * Local-driver static-ish serve route.
 *
 * Intentionally public — there is no `auth(true)` here on purpose.
 * Authorization is enforced via the URL itself: keys are prefixed
 * `public/` or `private/` at upload time. Public keys serve unsigned;
 * private keys MUST present a valid HMAC signature + expiry. Any key
 * whose prefix isn't recognized is treated as private and rejected
 * — fail closed.
 *
 * Only mounted when STORAGE_DRIVER=local; the s3 driver bypasses this
 * route since its presigned URLs point at S3 directly.
 *
 * Errors propagate through the centralized errorHandler so the
 * response shape `{ error: { code, message } }` stays consistent
 * with the rest of the API.
 */
router.get(
  '/_files/*',
  asyncHandler(async (req, res) => {
    const storage = getStorageDriver();
    if (storage.name !== 'local' || !storage.streamPath) {
      throw new NotFoundError('file');
    }

    // Express wildcard captures the rest of the path. Decode and
    // normalize to defend against traversal.
    const rawKey = req.params[0];
    const key = decodeURI(rawKey);
    if (key.includes('..')) {
      throw new ValidationError('invalid file key');
    }

    const isPublic = storage.isPublicKey ? storage.isPublicKey(key) : false;

    if (!isPublic) {
      // Private (or unknown-prefix) keys MUST present a signature.
      // Missing or invalid both fail closed.
      const exp = req.query.exp;
      const sig = req.query.sig;
      if (!exp || !sig || !storage.verifySignedRequest(key, exp, sig)) {
        throw new ForbiddenError('invalid or expired signed URL');
      }
    } else if (req.query.exp || req.query.sig) {
      // Public keys ignore signatures, but if the caller supplied
      // them, validate that they match (so signed URLs to public keys
      // don't quietly pass a stale-sig check).
      if (!storage.verifySignedRequest(key, req.query.exp, req.query.sig)) {
        throw new ForbiddenError('invalid or expired signed URL');
      }
    }

    const filePath = storage.streamPath(key);
    const exists = await new Promise((resolve) =>
      fs.stat(filePath, (err) => resolve(!err))
    );
    if (!exists) throw new NotFoundError('file');

    res.sendFile(path.resolve(filePath));
  })
);

module.exports = router;
