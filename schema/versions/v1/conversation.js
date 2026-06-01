/**
 * Conversation — durable chat history for `@davepi/agent`.
 *
 * Before this schema, `runTurn` round-tripped `history` to the caller
 * but nothing stored it: a restart (or a stateless HTTP client) lost the
 * thread, and `lib/store.js` deliberately holds only auth tokens.
 * Conversation history is tenant data, so it belongs in davepi rather
 * than the agent host's local JSON file (the open question resolved in
 * docs/agent-learning-layer.md §11.1).
 *
 * One row per `(tenant, agentKey, channel, conversationId)`. The
 * `conversationId` is the channel's notion of a single conversation —
 * Slack's per-thread key (`channel::thread_ts`), or one ongoing
 * conversation per logged-in HTTP user — NOT just the end-user id. That
 * distinction matters: keying by end-user alone would collapse every
 * Slack thread and DM for one person into a single transcript and leak
 * context across them. `channelUserId` is still recorded (for the
 * per-user customer-profile lookup and audit) but is not the key. The
 * agent loads the row at the start of every turn and writes the updated
 * transcript back, so history survives across requests and restarts.
 *
 * **It also carries the frozen prompt snapshot.** `systemSnapshot` is
 * the assembled prompt prefix (persona + operating contract + memory +
 * profile) captured at session start and held byte-stable for the whole
 * session — that byte-stability is what keeps Anthropic prompt caching
 * hitting turn after turn. `snapshotAt` / `lastTurnAt` let the agent
 * decide when a gap is long enough to count as a *new* session and
 * re-snapshot (picking up memory/profile writes from the prior session).
 * Mid-session writes never mutate the live snapshot.
 *
 * **Tenant isolation is the default, owner-only scope** — no `acl.list`
 * / `acl.scope` bypass. The agent both reads and writes its own
 * conversation rows under its tenant identity through the
 * schema-generated MCP tools; nothing here grants a cross-tenant path.
 * `history` and `systemSnapshot` are stored as JSON / text strings so
 * the transcript shape stays opaque to the framework's GraphQL type
 * generation (the same approach `agentPersona.proposedPatch` takes).
 *
 * **Resolution is the learning-loop trigger (docs/agent-learning-layer.md
 * §7, #132).** `status` is a one-way state machine — `open → resolved`
 * (the conversation reached a good outcome) or `open → abandoned` (it
 * petered out / was dropped); both are terminal. The agent (or an
 * operator) closes a conversation by transitioning `status` over the
 * normal update surface, which is davepi-native and works on REST,
 * GraphQL, *and* MCP alike. There's no field ACL on `status`, so the
 * agent's service role can resolve its own conversations.
 *
 * Arriving at `resolved` fires an `onEnter` hook that emits a dedicated
 * `conversation.resolved` record event on `utils/events.js` carrying the
 * **full transcript**. We emit our own event rather than leaning on the
 * generic `${path}.transitioned` one for two reasons: it's the exact
 * semantic signal the learning loop subscribes to, and — critically —
 * the MCP/GraphQL `transitioned` events deliberately omit the `record`
 * payload, so a subscriber there would have no `history` to extract a
 * skill from. The event is the seam the queue plugin consumes
 * **off-thread** (extraction is slow + best-effort), so resolving a
 * conversation never blocks the response. `userId` rides as the tenant
 * owner so the extraction worker can scope any proposed skill back to
 * the originating account.
 */
const { emitRecordEvent } = require('../../../utils/events');

module.exports = {
  path: 'conversation',
  collection: 'conversation',
  fields: [
    { name: 'accountId', type: String, stamped: true },
    { name: 'userId', type: String, required: true, stamped: true },
    { name: 'agentKey', type: String, required: true, index: true, example: 'support' },
    { name: 'channel', type: String, required: true, example: 'slack' },
    // The channel's conversation scope — Slack thread key, or the HTTP
    // user. This is the persistence key, not channelUserId.
    { name: 'conversationId', type: String, required: true, index: true, example: 'C0123::1700000000.000100' },
    // Which end-user this conversation is with (recorded for the per-user
    // profile lookup + audit; not part of the uniqueness key).
    { name: 'channelUserId', type: String, index: true, example: 'U12345' },
    // JSON-serialised array of { role, content } messages.
    { name: 'history', type: String },
    // The frozen assembled prompt prefix for this session.
    { name: 'systemSnapshot', type: String },
    { name: 'snapshotAt', type: Date },
    { name: 'lastTurnAt', type: Date },
    // Lifecycle. `stampInitialStates` forces `open` on every create
    // surface; the agent (or an operator) drives the one-way close.
    // `resolved` is the learning-loop trigger; `abandoned` lets a
    // conversation be retired without proposing a skill. Both are
    // terminal — a closed conversation isn't reopened in place.
    {
      name: 'status',
      type: String,
      enum: ['open', 'resolved', 'abandoned'],
      default: 'open',
      stateMachine: {
        initial: 'open',
        states: ['open', 'resolved', 'abandoned'],
        transitions: {
          open: ['resolved', 'abandoned'],
          resolved: [],
          abandoned: [],
        },
        onEnter: {
          // Best-effort: a thrown emit must never roll back the
          // transition (same posture as audit / afterUpdate). The
          // queue plugin's `conversation.resolved` subscriber turns
          // this into a background skill-extraction job.
          resolved: async (record) => {
            emitRecordEvent({
              type: 'conversation.resolved',
              version: 'v1',
              // The conversation owner is the tenant; scope any proposed
              // skill back to this account, not the resolver's identity.
              userId: record && record.userId != null ? String(record.userId) : null,
              recordId: record && record._id != null ? String(record._id) : null,
              // Full row (incl. the serialized `history` transcript) so a
              // subscriber has everything the extraction worker needs
              // without a follow-up read.
              record,
            });
          },
        },
      },
    },
  ],
  compositeIndex: [
    { userId: 1, agentKey: 1, channel: 1, conversationId: 1 },
  ],
};
