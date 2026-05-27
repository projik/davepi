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
  { timestamps: true, collection: 'api_client' }
);

module.exports =
  mongoose.models.api_client || mongoose.model('api_client', apiClientSchema);
