/**
 * Administrative surface for issuing API client IDs. The `_id` of
 * each row IS the public client ID frontends embed in their builds
 * (e.g. `pk_storefront_live_abc123`). Admins create, name, and
 * revoke client IDs through the standard REST / GraphQL routes;
 * the `middleware/clientAuth.js` middleware resolves the
 * `X-Client-Id` request header against this collection.
 *
 * Locked down to the `admin` role on every surface. The collection
 * name matches the hand-written `model/apiClient.js` so both register
 * the same Mongoose model.
 */
module.exports = {
  path: 'apiClient',
  collection: 'api_client',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'accountId', type: String },
    { name: '_id', type: String, required: true, example: 'pk_storefront_live_abc123' },
    { name: 'name', type: String, required: true, example: 'storefront-prod' },
    { name: 'role', type: String, required: true, example: 'storefront' },
    {
      name: 'status',
      type: String,
      enum: ['active', 'revoked'],
      default: 'active',
    },
    { name: 'description', type: String },
  ],
  acl: {
    list: ['admin'],
    delete: ['admin'],
  },
};
