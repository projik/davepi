'use strict';

/**
 * The three plugin-owned REST routes that drive the presigned-URL
 * upload pipeline. Mounted by the plugin's setup() onto the same
 * Express app the schema layer uses, so requests go through the
 * framework's terminal `errorHandler` for response shape consistency.
 *
 * All three require `auth(true)` so a JWT is present; `userId` comes
 * off `req.user.user_id` exactly like the framework's auto-generated
 * REST handlers.
 *
 * Routes:
 *
 *   POST   /api/files/upload-url      — issue a presigned PUT URL +
 *                                       create a `pending` file record
 *   POST   /api/files/:fileId/complete — verify the upload landed,
 *                                       flip status to `uploaded`
 *   GET    /api/files/:fileId/download-url — issue a short-lived
 *                                            presigned GET URL
 *
 * Tenant scope is enforced at the route layer (`userId` filter on
 * every Mongo query). The schema's write-locked fields are a second
 * line of defence at the framework's generic CRUD surface, but for
 * these custom routes the plugin is the only writer and validates
 * directly.
 */

const { buildKey } = require('./keys');
const { validateUploadRequest } = require('./config');

function buildRouter({
  router,
  auth,
  asyncHandler,
  errors,
  getModel,
  adapter,
  config,
}) {
  const { NotFoundError, ValidationError, ForbiddenError } = errors;

  function ownerOnly(record, userId) {
    if (!record) throw new NotFoundError('file');
    if (String(record.userId) !== String(userId)) {
      // 404, not 403 — never leak that a foreign-tenant file exists.
      throw new NotFoundError('file');
    }
  }

  router.post(
    '/upload-url',
    auth(true),
    asyncHandler(async (req, res) => {
      const userId = req.user && req.user.user_id;
      if (!userId) throw new ForbiddenError('auth required');

      const { contentType, originalName, size, metadata } = req.body || {};
      // Single source of truth for upload-policy validation — shared
      // with the programmatic `createUploadUrl` API so a hook author
      // can't bypass MIME / size checks by reaching for the JS surface.
      validateUploadRequest({ contentType, size, config, errors });

      const key = buildKey({ userId, originalName });
      const Model = getModel();
      const doc = await Model.create({
        userId:        String(userId),
        accountId:     req.user.account_id ? String(req.user.account_id) : undefined,
        key,
        bucket:        adapter.bucket,
        contentType,
        size:          size != null ? size : undefined,
        status:        'pending',
        originalName:  originalName || undefined,
        metadata:      metadata && typeof metadata === 'object' ? metadata : undefined,
      });

      const url = await adapter.getSignedPutUrl({
        key,
        contentType,
        expires: config.putUrlTtlSeconds,
      });

      res.status(201).json({
        fileId:      String(doc._id),
        key,
        url,
        expiresIn:   config.putUrlTtlSeconds,
        contentType,
      });
    })
  );

  router.post(
    '/:fileId/complete',
    auth(true),
    asyncHandler(async (req, res) => {
      const userId = req.user && req.user.user_id;
      if (!userId) throw new ForbiddenError('auth required');

      const Model = getModel();
      const doc = await Model.findById(req.params.fileId);
      ownerOnly(doc, userId);

      if (doc.status === 'uploaded') {
        // Idempotent — the client may legitimately retry /complete if
        // the PUT response was ambiguous (network blip, mobile network
        // killing the connection mid-200). Return the existing state.
        return res.status(200).json(serialize(doc));
      }

      if (config.verifyOnComplete) {
        const head = await adapter.headObject({ key: doc.key });
        if (!head.exists) {
          throw new ValidationError(
            'upload not found in storage; client must PUT to the presigned URL before calling /complete'
          );
        }
        // If the client provided a size at upload-url time, validate
        // the storage layer reports the same value. A mismatch usually
        // means the client lied at presign time to bypass the maxBytes
        // gate, then PUT a bigger file.
        if (
          typeof doc.size === 'number' &&
          typeof head.contentLength === 'number' &&
          doc.size !== head.contentLength
        ) {
          throw new ValidationError(
            `uploaded size ${head.contentLength} does not match declared size ${doc.size}`
          );
        }
        if (
          typeof head.contentLength === 'number' &&
          head.contentLength > config.maxBytes
        ) {
          // Even if the client didn't declare a size up-front, refuse
          // to flip to `uploaded` if the actual blob is over the limit.
          // The blob stays in the bucket — the reaper / cascade-delete
          // path will eventually clean it up.
          throw new ValidationError(
            `uploaded size ${head.contentLength} exceeds S3_MAX_BYTES (${config.maxBytes})`
          );
        }
        if (head.contentLength != null) doc.size = head.contentLength;
        if (head.etag) doc.etag = head.etag;
      }

      doc.status = 'uploaded';
      doc.uploadedAt = new Date();
      await doc.save();

      res.status(200).json(serialize(doc));
    })
  );

  router.get(
    '/:fileId/download-url',
    auth(true),
    asyncHandler(async (req, res) => {
      const userId = req.user && req.user.user_id;
      if (!userId) throw new ForbiddenError('auth required');

      const Model = getModel();
      const doc = await Model.findById(req.params.fileId);
      ownerOnly(doc, userId);

      if (doc.status !== 'uploaded') {
        throw new ValidationError(
          `file ${req.params.fileId} is in status "${doc.status}"; only uploaded files can be downloaded`
        );
      }

      const url = await adapter.getSignedGetUrl({
        key:     doc.key,
        expires: config.getUrlTtlSeconds,
      });

      res.status(200).json({
        fileId:     String(doc._id),
        url,
        expiresIn:  config.getUrlTtlSeconds,
      });
    })
  );

  return router;
}

function serialize(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    fileId:       String(o._id),
    userId:       o.userId,
    accountId:    o.accountId || null,
    key:          o.key,
    bucket:       o.bucket || null,
    contentType:  o.contentType,
    size:         o.size != null ? o.size : null,
    status:       o.status,
    originalName: o.originalName || null,
    metadata:     o.metadata || null,
    uploadedAt:   o.uploadedAt || null,
    etag:         o.etag || null,
    createdAt:    o.createdAt || null,
    updatedAt:    o.updatedAt || null,
  };
}

module.exports = { buildRouter, serialize };
