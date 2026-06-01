/**
 * Administrative surface for issuing API client IDs. The `_id` of
 * each row IS the public client ID frontends embed in their builds
 * (e.g. `pk_storefront_live_abc123`). Admins create, name, and
 * revoke client IDs through the standard REST / GraphQL routes;
 * the `middleware/clientAuth.js` middleware resolves the
 * `X-Client-Id` request header against this collection.
 *
 * **Admin-only writes are critical for security.** The `role` column
 * is read by `clientAuth` and stamped directly into `req.user.roles`
 * for the synthetic user. A non-admin caller who could create an
 * apiClient with `role: 'admin'` would privilege-escalate to admin
 * across every collection by sending that ID as `X-Client-Id`. Two
 * layers enforce admin-only writes:
 *
 *   1. Field-level `acl.create` / `acl.update` strips every
 *      writable field for non-admins via `filterWritable` — a plain
 *      user's POST body ends up empty, the Mongoose `required: true`
 *      on `name` / `role` fires, and the request fails 400.
 *   2. `beforeCreate` / `beforeUpdate` hooks throw `ForbiddenError`
 *      if the caller is not admin (or is a client-authed caller).
 *      Defence in depth — even if a future schema-loader change
 *      relaxed strip semantics, the hook still refuses.
 */
const { ForbiddenError } = require('../../../utils/errors');

const ADMIN_ONLY = { create: ['admin'], update: ['admin'] };

const requireAdmin = ({ user }) => {
  const roles = (user && user.roles) || [];
  if (user && user.isClient) {
    throw new ForbiddenError('apiClient writes require admin');
  }
  if (!roles.includes('admin')) {
    throw new ForbiddenError('apiClient writes require admin');
  }
};

module.exports = {
  path: 'apiClient',
  collection: 'api_client',
  fields: [
    { name: 'userId', type: String, required: true, stamped: true },
    { name: 'accountId', type: String, stamped: true },
    { name: '_id', type: String, required: true, example: 'pk_storefront_live_abc123', acl: ADMIN_ONLY },
    { name: 'name', type: String, required: true, example: 'storefront-prod', acl: ADMIN_ONLY },
    { name: 'role', type: String, required: true, example: 'storefront', acl: ADMIN_ONLY },
    {
      name: 'status',
      type: String,
      enum: ['active', 'revoked'],
      default: 'active',
      acl: ADMIN_ONLY,
    },
    { name: 'description', type: String, acl: ADMIN_ONLY },
  ],
  acl: {
    list: ['admin'],
    delete: ['admin'],
  },
  hooks: {
    beforeCreate: async ({ input, user }) => {
      requireAdmin({ user });
      return input;
    },
    beforeUpdate: async ({ input, user }) => {
      requireAdmin({ user });
      return input;
    },
    beforeDelete: async ({ user }) => {
      requireAdmin({ user });
    },
  },
};
