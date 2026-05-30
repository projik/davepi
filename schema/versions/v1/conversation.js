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
 * One row per `(tenant, agentKey, channel, channelUserId)`. The agent
 * loads it at the start of every turn and writes the updated transcript
 * back, so history survives across requests and process restarts.
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
 */
module.exports = {
  path: 'conversation',
  collection: 'conversation',
  fields: [
    { name: 'accountId', type: String },
    { name: 'userId', type: String, required: true },
    { name: 'agentKey', type: String, required: true, index: true, example: 'support' },
    { name: 'channel', type: String, required: true, example: 'slack' },
    { name: 'channelUserId', type: String, required: true, index: true, example: 'U12345' },
    // JSON-serialised array of { role, content } messages.
    { name: 'history', type: String },
    // The frozen assembled prompt prefix for this session.
    { name: 'systemSnapshot', type: String },
    { name: 'snapshotAt', type: Date },
    { name: 'lastTurnAt', type: Date },
  ],
  compositeIndex: [
    { userId: 1, agentKey: 1, channel: 1, channelUserId: 1 },
  ],
};
