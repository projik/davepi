/**
 * Customer profile — the USER.md analog for `@davepi/agent`.
 *
 * One row per `(tenant, endUserKey)` holding the slow-changing
 * preferences and notes an agent has learned about a specific end-user
 * ("prefers email over phone", "always asks about the EU region first").
 * `packages/davepi-agent/lib/promptAssembly.js` reads it as prompt
 * **slot #5** (the customer-profile snapshot) at session start and
 * freezes it for the conversation, same discipline as agent memory
 * (docs/agent-learning-layer.md §5).
 *
 * **Shared across agents of the same tenant.** Unlike persona/memory,
 * the profile is keyed by `endUserKey` and carries NO `agentKey` — so
 * what the support agent learns about a customer benefits the sales
 * agent too. Tenant isolation is still the hard floor: no `acl.list` /
 * `acl.scope` bypass, so the per-`userId` owner scope keeps account A's
 * profiles unreadable to account B over REST, GraphQL, and MCP.
 *
 * **Self-authored.** Like memory, this is a surface the agent writes
 * (no `OPERATOR_WRITE` ACL): the `agent` role creates/updates profiles
 * via the schema-generated MCP tools, and the write lands in the *next*
 * session's frozen snapshot.
 *
 * **Injection note.** `preferences` / `notes` are partly written from
 * end-user input, so they are an injection vector into a future
 * session's prompt. The prompt assembler runs the same sanitizer over
 * this text that it runs over the persona before it enters the prompt —
 * the storage layer holds the raw text; the prompt layer neutralises it.
 *
 * **Provenance via `updatedBy`** follows the same two-layer pattern as
 * `agentMemory`: `default: 'agent'` for the hookless MCP self-authored
 * path, hooks override with the operator identity on human REST/GraphQL
 * edits. The hooks also refresh `lastSeenAt` on every write.
 */

const isOperator = (user) => {
  if (!user || user.isClient) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return roles.includes('admin') || roles.includes('user');
};

const provenanceOf = (user) => {
  if (!user) return 'system';
  if (isOperator(user)) return `operator:${user.user_id}`;
  return 'agent';
};

module.exports = {
  path: 'customerProfile',
  collection: 'customer_profile',
  fields: [
    { name: 'accountId', type: String },
    { name: 'userId', type: String, required: true },
    {
      name: 'endUserKey',
      type: String,
      required: true,
      index: true,
      example: 'slack:U12345',
    },
    {
      name: 'preferences',
      type: String,
      example: '{"contact":"email","region":"EU"}',
    },
    { name: 'notes', type: String, example: 'Prefers concise answers. Repeat customer since 2024.' },
    { name: 'lastSeenAt', type: Date },
    { name: 'updatedBy', type: String, default: 'agent' },
  ],
  compositeIndex: [
    // One profile per (tenant, endUserKey) — shared across the tenant's
    // agents because no agentKey participates in the key.
    { userId: 1, endUserKey: 1 },
  ],
  hooks: {
    beforeCreate: async ({ input, user }) => ({
      ...input,
      updatedBy: provenanceOf(user),
      lastSeenAt: input.lastSeenAt || new Date(),
    }),
    beforeUpdate: async ({ input, user }) => ({
      ...input,
      updatedBy: provenanceOf(user),
      lastSeenAt: new Date(),
    }),
  },
};
