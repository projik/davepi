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
 * **Operators own brand voice and compliance "avoid" rules.** An agent
 * may *propose* persona edits through the normal update surface, but
 * the `beforeUpdate` hook below routes any **agent-authored** write into
 * the `proposedPatch` field for human review instead of mutating the
 * live persona. Operator writes (callers without the `agent` service
 * role) apply directly — that's how an operator authors the persona and
 * how they approve a pending patch (PUT the real fields, clear
 * `proposedPatch`). This keeps a self-mutating agent from rewriting its
 * own guardrails unreviewed.
 *
 * `agentKey` is unique per account via the `(userId, agentKey)`
 * composite index, so one tenant can run many agents (support, sales,
 * billing-ops) off distinct rows.
 */

// The agent's service identity carries this role; an operator does not.
const AGENT_ROLE = 'agent';

// The four Hermes persona sections an agent may propose edits to.
const PERSONA_SECTIONS = ['identity', 'style', 'avoid', 'defaults'];

const isAgentAuthor = (user) => {
  if (!user || user.isClient) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [];
  // Treat a write as agent-authored only when the dedicated service
  // role is present AND the caller isn't also an operator — an admin
  // editing through an agent token still gets the operator path.
  return roles.includes(AGENT_ROLE) && !roles.includes('admin');
};

module.exports = {
  path: 'agentPersona',
  collection: 'agent_persona',
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
    { name: 'identity', type: String, example: 'You are Ada, the support agent for Acme.' },
    { name: 'style', type: String, example: 'Warm, concise, never more than three sentences.' },
    { name: 'avoid', type: String, example: 'Never speculate about refunds or promise dates.' },
    { name: 'defaults', type: String, example: 'Assume the customer is on the Pro plan unless told otherwise.' },
    {
      name: 'status',
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
    },
    // Agent-proposed persona edits awaiting operator approval. Written
    // only by the beforeUpdate hook when the caller is agent-authored;
    // operators read it, then apply or discard it on their own update.
    { name: 'proposedPatch', type: String },
  ],
  compositeIndex: [
    // One persona per (tenant, agentKey). accountId is stamped equal to
    // userId, so the owner-scoped composite index enforces uniqueness
    // per account.
    { userId: 1, agentKey: 1 },
  ],
  hooks: {
    beforeUpdate: async ({ input, user }) => {
      if (!isAgentAuthor(user)) return input; // operators write through
      // Capture only the persona-section edits the agent submitted and
      // stash them as a single proposed patch. Returning a payload that
      // touches *only* proposedPatch leaves the live identity, status,
      // and compliance "avoid" rules exactly as the operator left them.
      const patch = {};
      for (const f of PERSONA_SECTIONS) {
        if (Object.prototype.hasOwnProperty.call(input, f)) patch[f] = input[f];
      }
      return { proposedPatch: JSON.stringify(patch) };
    },
  },
};
