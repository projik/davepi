const ApiClient = require('../model/apiClient');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Resolve `X-Client-Id` into a synthetic `req.user` so the existing
 * role-based ACL machinery (`field.acl.read`, `schema.acl.list`,
 * `schema.acl.scope[role]`) can govern access for callers that
 * have no JWT.
 *
 * Client IDs are identifiers, not secrets — they're baked into SPA
 * bundles and are world-readable. They identify which frontend is
 * making the call; the security boundary is what the role can read
 * (scoped via `schema.acl.scope`) and the per-resource ACL, not the
 * client ID itself. Rotate by revoking the row and redeploying with
 * a fresh ID.
 *
 * Ordering vs `auth(true)`:
 *  - If a real `Authorization: Bearer ...` is present, the Bearer
 *    wins. We don't even look up the client header — `auth(true)`
 *    will overwrite `req.user` from the JWT, and the client ID is
 *    additive context only (logged for audit).
 *  - If only `X-Client-Id` is present, we resolve the client and
 *    synthesise `req.user = { user_id: <id>, roles: [<role>], isClient: true }`.
 *    Downstream `auth(true)` sees the populated `req.user` and skips
 *    its own Bearer requirement.
 *  - If neither is present, we pass through unchanged; `auth(true)`
 *    will 403 as it always has.
 *
 * Writes from client-authed callers are refused: any non-GET request
 * that resolved via `X-Client-Id` is rejected with 403. This is the
 * conservative posture for v1 — public writes (contact forms,
 * anonymous order placement) are an opt-in we can add later. The
 * synthetic user_id being the client ID itself means lifecycle
 * stamping doesn't crash on null, but it also means a leaked write
 * permission would create records attributed to the client — the
 * defence in depth is to refuse outright at the middleware.
 */
const clientAuth = () => asyncHandler(async (req, res, next) => {
  // Bearer takes priority. Let auth(true) handle it.
  const hasBearer =
    req.headers.authorization &&
    /^bearer\s+/i.test(req.headers.authorization);
  if (hasBearer) return next();

  const headerName = 'x-client-id';
  const raw = req.headers[headerName];
  if (!raw) return next();
  const id = String(raw).trim();
  if (!id) return next();

  let client;
  try {
    client = await ApiClient.findById(id).lean();
  } catch (err) {
    logger.warn({ err, clientId: id }, 'clientAuth lookup failed');
    return next(new UnauthorizedError('Invalid client ID'));
  }
  if (!client) return next(new UnauthorizedError('Invalid client ID'));
  if (client.status !== 'active') {
    return next(new UnauthorizedError('Client ID revoked'));
  }

  // REST writes are refused outright. GraphQL queries arrive as POST,
  // so we let POST through to the Apollo router; the scope-resolver
  // mutation wrappers refuse client-authed mutations downstream.
  const isGraphql = req.path.startsWith('/graphql') || req.baseUrl === '/graphql';
  const isWriteMethod = req.method !== 'GET' && req.method !== 'HEAD';
  if (isWriteMethod && !isGraphql) {
    return next(new ForbiddenError('Client-authenticated requests are read-only'));
  }

  req.user = {
    user_id: client._id,
    roles: [client.role],
    isClient: true,
    clientId: client._id,
    clientName: client.name,
  };
  req.clientAuth = { id: client._id, role: client.role, name: client.name };
  return next();
});

module.exports = clientAuth;
