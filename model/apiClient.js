const mongoose = require('mongoose');

/**
 * Issued API client IDs. Resolved by `middleware/clientAuth.js`
 * against the `X-Client-Id` request header. The `_id` IS the public
 * client ID (e.g. `pk_storefront_*`) — these are identifiers, not
 * secrets: they get baked into SPA bundles and are world-readable.
 * The role attached here drives the existing ACL surface
 * (`field.acl.read`, `schema.acl.list`, `schema.acl.scope[role]`).
 *
 * Administrative CRUD on this collection is handled by the
 * `apiClient` schema under `schema/versions/v1/` so it gets the
 * standard surfaces (REST, GraphQL, swagger, MCP, admin UI). This
 * model file is kept hand-written because clientAuth needs to load
 * it before the schemaLoader has registered any auto-generated
 * models.
 */
const apiClientSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    userId: { type: String, required: true },
    accountId: { type: String },
    description: { type: String },
  },
  // Model name 'api_client' pluralizes to collection 'api_clients' —
  // the same name the schema-loader produces from
  // `schema/versions/v1/apiClient.js`. Both code paths must share a
  // collection so admin CRUD via the auto-generated routes and the
  // runtime lookup in `middleware/clientAuth.js` see the same docs.
  { timestamps: true }
);

module.exports =
  mongoose.models.api_client || mongoose.model('api_client', apiClientSchema);
