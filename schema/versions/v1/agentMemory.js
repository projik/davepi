/**
 * Agent memory — the MEMORY.md analog for `@davepi/agent`.
 *
 * One row per `(tenant, agentKey)` holding a single free-form `body`:
 * the slow-changing facts an agent has learned about how this tenant
 * operates ("EU customer base — default to GDPR-safe phrasing", "the Pro
 * plan is the common case"). `packages/davepi-agent/lib/promptAssembly.js`
 * reads it as prompt **slot #4** (the memory snapshot) at session start
 * and freezes it for the whole conversation — so a fact recorded in one
 * session shows up in the *next* one, never mid-flight (see
 * docs/agent-learning-layer.md §5, the frozen-snapshot discipline).
 *
 * **Tenant isolation is the default, owner-only scope.** No
 * `acl.list` / `acl.scope` bypass, so the per-`userId` owner scope every
 * auto-generated route enforces applies untouched: account A cannot read
 * or write account B's memory over REST, GraphQL, or MCP.
 *
 * **Self-authored, unlike the persona.** Memory is exactly the surface
 * the agent is meant to write — "the customer prefers email" is a fact
 * the agent records, not brand voice an operator owns. So there is no
 * field-level `OPERATOR_WRITE` ACL here: an `agent`-role caller sharing
 * the tenant's `userId` can create/update its own memory through the
 * schema-generated `create_agentMemory` / `update_agentMemory` MCP tools.
 * Because the frozen snapshot is captured once per session, that write
 * takes effect on the *next* session — consistent with the cache-stable
 * prompt discipline, and the reason memory is safe to self-author where
 * the persona is not.
 *
 * **Provenance via `updatedBy`.** Schema `create`/`update` hooks run on
 * the REST and GraphQL write paths but NOT on MCP (a deliberate framework
 * invariant — see CLAUDE.md "Extensibility"; only `delete` hooks run on
 * MCP, as a governance gate). The agent writes over MCP,
 * so a hook alone can't stamp provenance for the common case. We use two
 * layers that together cover every surface: the field `default: 'agent'`
 * fires on the hookless MCP create (the agent's own self-authored path),
 * and the `beforeCreate` / `beforeUpdate` hooks override it with the
 * operator identity when a human edits the memory through the dashboard
 * (REST/GraphQL). So `updatedBy` reads `agent` for self-authored memory
 * and `operator:<id>` once a human has corrected it.
 */

// Roles a human operator holds; the agent's service role is `agent`.
const isOperator = (user) => {
  if (!user || user.isClient) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return roles.includes('admin') || roles.includes('user');
};

// Short provenance tag for the `updatedBy` field. Hooks only run on
// REST/GraphQL, so this is reached for human edits; the MCP (agent) path
// falls through to the field default of `agent`.
const provenanceOf = (user) => {
  if (!user) return 'system';
  if (isOperator(user)) return `operator:${user.user_id}`;
  return 'agent';
};

module.exports = {
  path: 'agentMemory',
  collection: 'agent_memory',
  fields: [
    { name: 'accountId', type: String },
    { name: 'userId', type: String, required: true },
    {
      name: 'agentKey',
      type: String,
      required: true,
      index: true,
      example: 'support',
    },
    {
      name: 'body',
      type: String,
      example: 'Customer base is mostly EU — default to GDPR-safe phrasing. Assume Pro plan unless told otherwise.',
    },
    // Provenance. Defaults to `agent` so the hookless MCP create path
    // (the agent self-authoring) is marked; the hooks below override it
    // with the operator identity on human REST/GraphQL edits.
    { name: 'updatedBy', type: String, default: 'agent' },
  ],
  compositeIndex: [
    // One memory body per (tenant, agentKey). accountId is stamped equal
    // to userId, so the owner-scoped composite index enforces uniqueness
    // per account.
    { userId: 1, agentKey: 1 },
  ],
  hooks: {
    beforeCreate: async ({ input, user }) => ({ ...input, updatedBy: provenanceOf(user) }),
    beforeUpdate: async ({ input, user }) => ({ ...input, updatedBy: provenanceOf(user) }),
  },
};
