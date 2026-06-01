/**
 * Skill — procedural memory for `@davepi/agent` (the Hermes skills analog).
 *
 * A skill is a reusable runbook the agent retrieves and follows: "how we
 * issue a refund", "the steps to triage a shipping complaint". Unlike
 * persona (identity) and memory (slow-changing facts), skills are
 * *procedures* surfaced through **progressive disclosure** so a hundred
 * runbooks don't bloat every prompt (docs/agent-learning-layer.md §6):
 *
 *   - **L0** — `name` + `description` of `approved` skills are injected
 *     into the system prompt as **slot #3** by
 *     `packages/davepi-agent/lib/promptAssembly.js`. This is the cheap,
 *     always-present index: just enough for the model to know a runbook
 *     exists and decide to read it.
 *   - **L1** — the full `body` (markdown) is fetched on demand via the
 *     schema-generated `get_skill` MCP tool, only once the model has
 *     chosen to follow a skill from the L0 index.
 *   - **L2** — `attachments` (object-storage `File`) are pulled through
 *     the existing file tools only when the body references them.
 *
 * This mirrors the "load detail only when selected" discipline the tool
 * router already applies to tool schemas, now applied to knowledge.
 *
 * **Governance — a self-authored runbook cannot reach a live customer
 * unreviewed.** Skills carry a `stateMachine` on `status` with a one-way
 * lifecycle: `draft → approved → deprecated`, where `deprecated` is
 * terminal — a retired runbook is never re-approved in place (which would
 * silently re-enter the L0 index); authoring a fresh skill is the path
 * back. Two layers enforce that an agent can author drafts but only a
 * human operator can promote one, and they hold on every write surface
 * (REST, GraphQL, *and* MCP — the agent writes over MCP):
 *
 *   1. **The state machine stamps `draft` on every create.**
 *      `stampInitialStates` runs on the REST, GraphQL, and MCP create
 *      paths and forces `status` to the declared `initial` (`draft`)
 *      regardless of what the caller supplied — so an agent (or a forged
 *      `{ status: 'approved' }`) can never author a live skill. The
 *      `beforeCreate` hook below re-asserts this for the REST/GraphQL
 *      paths as defence-in-depth and a clear contract.
 *   2. **Field-level ACL gates the transition to operators.** `status`
 *      declares `acl.{create,update}: ['user','admin']`, so `filterWritable`
 *      strips it from any write by the `agent` service role on every
 *      surface. An agent therefore cannot transition `draft → approved`
 *      (or any transition); only a human operator can. The state
 *      machine's transition graph then constrains the operator to the
 *      legal one-way `draft → approved → deprecated` path (and refuses
 *      reactivating a `deprecated` skill).
 *
 * Because the L0 index only ever lists `approved` skills, a half-baked
 * self-authored runbook stays invisible to customers until a human signs
 * off, and a `deprecated` skill drops out of the index again — the
 * safeguard Hermes's auto-reuse lacks on a customer-facing surface.
 *
 * **Tenant isolation is the hard floor.** No `acl.list` / `acl.scope`
 * bypass, so the per-`userId` owner scope every auto-generated route
 * enforces applies untouched: account A cannot read or write account B's
 * skills over REST, GraphQL, or MCP. The agent reads its skills under its
 * own MCP identity, which owns the tenant's data in service mode.
 *
 * `agentKey` scopes a skill to one agent within the tenant, and the
 * `(userId, agentKey, name)` composite index makes skill names unique per
 * agent so an operator (or the learning loop in #132) can upsert by name.
 */
const { ForbiddenError } = require('../../../utils/errors');

// Roles a human operator holds. The agent's service role (`agent`) is
// deliberately excluded so `filterWritable` strips `status` from any
// agent-authored create/update — the agent may write content fields but
// never the governed status that controls live visibility.
const OPERATOR_STATUS = { create: ['user', 'admin'], update: ['user', 'admin'] };

const isAgentAuthor = (user) => {
  if (!user || user.isClient) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return roles.includes('agent') && !roles.includes('admin');
};

module.exports = {
  path: 'skill',
  collection: 'skill',
  fields: [
    { name: 'accountId', type: String, stamped: true },
    { name: 'userId', type: String, required: true, stamped: true },
    {
      name: 'agentKey',
      type: String,
      required: true,
      index: true,
      example: 'support',
    },
    // L0 title. Searchable and weighted above the description so a `q`
    // search ranks name matches first.
    {
      name: 'name',
      type: String,
      required: true,
      index: true,
      searchable: true,
      searchWeight: 5,
      example: 'Issue a refund',
    },
    // L0 summary — the one-liner that lands in the prompt index so the
    // model can decide whether to read the full body.
    {
      name: 'description',
      type: String,
      searchable: true,
      example: 'How to issue a refund within policy, including the approval threshold.',
    },
    // L1 — the full runbook, fetched on demand via `get_skill`. Kept out
    // of the L0 index so the prompt stays cache-stable and cheap.
    {
      name: 'body',
      type: String,
      example: '1. Confirm the order is within the 30-day window.\n2. ...',
    },
    // L2 — an optional object-storage attachment (a PDF runbook, a
    // template). Private access: these are internal procedures, served
    // only via short-lived signed URLs through the file tools, never a
    // stable public URL. The framework's `File` type is a single
    // sub-doc; one attachment per skill is enough for the common case.
    {
      name: 'attachments',
      type: 'File',
      file: { access: 'private' },
    },
    // Surfaced by the learning loop (#132) to rank promotion/retirement
    // candidates; bumped when an approved skill is fetched. Plain counter
    // for now.
    { name: 'useCount', type: Number, default: 0 },
    // Governed one-way lifecycle. `stampInitialStates` forces `draft` on
    // every create surface; the field ACL above keeps the agent out of
    // any transition, so only an operator drives draft → approved →
    // deprecated. draft → deprecated is allowed so an operator can retire
    // a bad draft without first approving it, and `deprecated` is
    // terminal — a retired skill is never reactivated in place.
    {
      name: 'status',
      type: String,
      enum: ['draft', 'approved', 'deprecated'],
      default: 'draft',
      acl: OPERATOR_STATUS,
      stateMachine: {
        initial: 'draft',
        states: ['draft', 'approved', 'deprecated'],
        transitions: {
          draft: ['approved', 'deprecated'],
          approved: ['deprecated'],
          // `deprecated` is terminal: a retired runbook is never
          // re-approved in place (that would silently re-enter the L0
          // index). Authoring a fresh skill is the supported path back.
          deprecated: [],
        },
      },
    },
  ],
  compositeIndex: [
    // Skill names are unique per (tenant, agentKey) so operators and the
    // learning loop can address a skill by name. accountId is stamped
    // equal to userId, so the owner-scoped index enforces per-account
    // uniqueness.
    { userId: 1, agentKey: 1, name: 1 },
  ],
  hooks: {
    // Defence-in-depth for the REST/GraphQL create paths: `stampInitialStates`
    // already forces `status: 'draft'`, but re-asserting it here documents
    // the governance contract and survives any future refactor of the
    // create pipeline.
    beforeCreate: async ({ input }) => ({ ...input, status: 'draft' }),
    // Delete has no field-level ACL, so this hook is the only gate that
    // keeps an agent token from dropping a governed runbook out from
    // under the operators who own it. It runs on every by-id delete
    // surface — REST, GraphQL, and MCP delete_skill — so an agent can't
    // route around it by calling the MCP tool directly.
    beforeDelete: async ({ user }) => {
      if (isAgentAuthor(user)) {
        throw new ForbiddenError('agents cannot delete a skill; ask an operator to deprecate it');
      }
    },
  },
};
