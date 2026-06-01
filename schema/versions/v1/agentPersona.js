/**
 * Agent persona — the SOUL.md analog for `@davepi/agent`.
 *
 * Each row is an owned, editable identity for one agent within one
 * tenant. `packages/davepi-agent/lib/promptAssembly.js` reads the row
 * for `(accountId/userId, agentKey)` and renders the four Hermes
 * sections (`identity`, `style`, `avoid`, `defaults`) as prompt
 * **slot #1** — the persistent identity that leads the system prompt.
 * With no row, the agent falls back to its built-in default prompt, so
 * the zero-config path keeps working exactly as before.
 *
 * **Tenant isolation is the default, owner-only scope.** Persona rows
 * carry no `acl.list` / `acl.scope` bypass, so the per-`userId` owner
 * scope that every auto-generated route enforces applies untouched:
 * account A's credentials cannot read account B's persona over REST,
 * GraphQL, or MCP. The agent reads its persona under its own MCP
 * identity — in service mode that identity owns the tenant's data, so
 * the read resolves; nothing here grants a cross-tenant read path.
 *
 * **Operators own brand voice and compliance "avoid" rules — and that
 * has to hold on every write surface, not just the ones that run hooks.**
 * The agent runtime exposes MCP CRUD tools to the model, so prompt
 * injection could try to drive `update_agentPersona` /
 * `delete_agentPersona`; MCP `create`/`update` do NOT run schema hooks
 * (nor do bulk paths), so a create/update hook alone is not a safe gate
 * (this is exactly why `apiClient` protects itself with field-level ACL
 * rather than hooks). The persona therefore enforces ownership with the
 * two layers that ARE universal:
 *
 *   1. **Field-level ACL (`OPERATOR_WRITE`) on every live field.**
 *      `filterWritable` runs on REST single + bulk PUT, all GraphQL
 *      create/update mutations, and MCP create/update, so an
 *      `agent`-role caller has `agentKey` / `identity` / `style` /
 *      `avoid` / `defaults` / `status` stripped from any create or
 *      update on any surface. Because `agentKey` is `required`, an
 *      agent-authored create fails validation outright (no field it may
 *      set), so an agent can neither author a live persona nor rewrite
 *      one. The agent's *only* writable field is `proposedPatch`.
 *   2. **`beforeDelete` hook refusing agent-authored deletes.** Delete
 *      has no field-level ACL, and the agent shares the owner's
 *      `userId` in service mode, so the hook is the gate for the by-id
 *      delete paths — REST, GraphQL, *and* MCP `delete_agentPersona`,
 *      which runs `beforeDelete` too. (Deleting a persona only reverts
 *      the agent to the safe default prompt — persona is never an
 *      access-control mechanism, see docs/agent-learning-layer.md §1 —
 *      so this is governance, not privilege containment.)
 *
 * **Self-authoring lands in `proposedPatch` for human review.** The
 * agent proposes edits by writing the dedicated `proposedPatch` field
 * (the one field its role may set); an operator reviews it and applies
 * the change to the live sections on their own update. This replaces an
 * earlier hook that rerouted agent edits into `proposedPatch` — a hook
 * can't enforce that on MCP/bulk, and it also clobbered a pending patch
 * whenever an agent update happened to carry no section fields.
 *
 * The deployment contract: the agent's service token carries role
 * `['agent']` (and NOT `user`/`admin`); the human operator authenticates
 * as a normal tenant user (role `user`/`admin`). Both share the tenant's
 * `userId`, so the agent reads the persona it owns while still being
 * write-gated by role.
 *
 * `agentKey` is unique per account via the `(userId, agentKey)`
 * composite index, so one tenant can run many agents (support, sales,
 * billing-ops) off distinct rows.
 */
const { ForbiddenError } = require('../../../utils/errors');

// Roles a human operator holds. The agent's service role (`agent`) is
// deliberately excluded, so `filterWritable` strips every live field
// from an agent-authored create/update on every surface.
const OPERATOR_WRITE = { create: ['user', 'admin'], update: ['user', 'admin'] };

const isAgentAuthor = (user) => {
  if (!user || user.isClient) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [];
  // Agent-authored only when the dedicated service role is present and
  // the caller isn't also an operator (admin editing via an agent token
  // still gets the operator path).
  return roles.includes('agent') && !roles.includes('admin');
};

module.exports = {
  path: 'agentPersona',
  collection: 'agent_persona',
  fields: [
    { name: 'accountId', type: String, stamped: true },
    { name: 'userId', type: String, required: true, stamped: true },
    {
      name: 'agentKey',
      type: String,
      required: true,
      index: true,
      example: 'support',
      acl: OPERATOR_WRITE,
    },
    {
      name: 'identity',
      type: String,
      example: 'You are Ada, the support agent for Acme.',
      acl: OPERATOR_WRITE,
    },
    {
      name: 'style',
      type: String,
      example: 'Warm, concise, never more than three sentences.',
      acl: OPERATOR_WRITE,
    },
    {
      name: 'avoid',
      type: String,
      example: 'Never speculate about refunds or promise dates.',
      acl: OPERATOR_WRITE,
    },
    {
      name: 'defaults',
      type: String,
      example: 'Assume the customer is on the Pro plan unless told otherwise.',
      acl: OPERATOR_WRITE,
    },
    {
      name: 'status',
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
      acl: OPERATOR_WRITE,
    },
    // The one field an agent may write: a free-form proposal an operator
    // reviews and applies to the live sections. Intentionally un-ACL'd
    // so the agent's service role can author it.
    { name: 'proposedPatch', type: String },
  ],
  compositeIndex: [
    // One persona per (tenant, agentKey). accountId is stamped equal to
    // userId, so the owner-scoped composite index enforces uniqueness
    // per account.
    { userId: 1, agentKey: 1 },
  ],
  hooks: {
    // Defence-in-depth for the REST/GraphQL by-id surfaces: field-level
    // ACL already makes an agent-authored create impossible (agentKey is
    // stripped, and it's required), but a hook gives a clear 403 instead
    // of a confusing "agentKey required" validation error.
    beforeCreate: async ({ input, user }) => {
      if (isAgentAuthor(user)) {
        throw new ForbiddenError('agents cannot author a persona; write proposedPatch for operator review');
      }
      return input;
    },
    // Delete has no field-level ACL and the agent shares the owner's
    // userId, so this is the gate that keeps an agent from dropping its
    // own guardrails on the by-id delete paths (REST, GraphQL, and MCP
    // delete_agentPersona — all three run beforeDelete).
    beforeDelete: async ({ user }) => {
      if (isAgentAuthor(user)) {
        throw new ForbiddenError('agents cannot delete a persona');
      }
    },
  },
};
