/**
 * Declarative state machines on schema fields.
 *
 * A field with a `stateMachine` config encodes a finite-state
 * transition graph at the schema layer:
 *
 *   { name: 'status', type: String,
 *     stateMachine: {
 *       initial: 'draft',
 *       states: ['draft', 'review', 'approved', 'rejected', 'archived'],
 *       transitions: {
 *         draft:    ['review', 'archived'],
 *         review:   ['approved', 'rejected'],
 *         approved: ['archived'],
 *         rejected: ['draft'],
 *       },
 *       onEnter: {
 *         approved: async (record, ctx) => { ... },
 *       },
 *     } }
 *
 * The framework enforces:
 *   - Every POST stamps `initial` (server-side; client can't pick a
 *     non-initial state on create).
 *   - PUT / GraphQL update / MCP update reject any change that
 *     isn't declared in transitions[current], surfacing
 *     `400 INVALID_TRANSITION` with current / attempted / allowed
 *     in the body.
 *   - Each successful transition appends an audit row
 *     (`action: 'transition'`) and emits a `${path}.transitioned`
 *     event on top of the regular `updated` event.
 *   - `onEnter[state]` runs once per arrival, with the same
 *     best-effort posture as audit (errors logged, never fail the
 *     mutation).
 *   - `availableTransitions` virtuals are attached per state-machine
 *     field on every read so clients can render the right action
 *     buttons without re-parsing the schema.
 *
 * Multiple state-machine fields per schema operate independently —
 * everything is per-field, not per-schema.
 */

const isStateMachineField = (f) =>
  Boolean(
    f &&
      f.stateMachine &&
      typeof f.stateMachine === 'object' &&
      Array.isArray(f.stateMachine.states) &&
      f.stateMachine.states.length > 0
  );

const stateMachineFieldsOf = (schema) =>
  Array.isArray(schema && schema.fields)
    ? schema.fields.filter(isStateMachineField)
    : [];

/**
 * Validate a proposed transition for a single state-machine field.
 *
 * Returns `{ valid: true, transition: boolean }` on accept (where
 * `transition: false` means "no-op, current === next") or
 * `{ valid: false, reason, message, current, attempted, allowed }`
 * on reject. The structured fields land in the
 * `INVALID_TRANSITION` error body so a client can render
 * actionable next-steps.
 *
 * `current === undefined / null` means "no value yet" — only the
 * initial state is acceptable from there.
 */
function validateTransition(field, current, next) {
  const sm = field.stateMachine;
  if (current === next) return { valid: true, transition: false };

  if (!sm.states.includes(next)) {
    return {
      valid: false,
      reason: 'unknown_state',
      message: `Unknown state '${next}'. Allowed: ${sm.states.join(', ')}`,
      current,
      attempted: next,
      allowed: sm.states.slice(),
    };
  }

  if (current === undefined || current === null || current === '') {
    if (next === sm.initial) return { valid: true, transition: true };
    return {
      valid: false,
      reason: 'initial_state_required',
      message: `New ${field.name} records must enter via initial state '${sm.initial}'`,
      current: null,
      attempted: next,
      allowed: [sm.initial],
    };
  }

  const allowed =
    (sm.transitions && Array.isArray(sm.transitions[current]) && sm.transitions[current]) || [];
  if (!allowed.includes(next)) {
    return {
      valid: false,
      reason: 'invalid_transition',
      message: `Cannot transition ${field.name} '${current}' → '${next}'. Allowed: ${
        allowed.length ? allowed.join(', ') : '(none — terminal state)'
      }`,
      current,
      attempted: next,
      allowed,
    };
  }
  return { valid: true, transition: true };
}

/**
 * The list of states reachable from `current`. With no current
 * value, that's just the initial state.
 */
function computeAvailableTransitions(field, current) {
  const sm = field.stateMachine;
  if (current === undefined || current === null || current === '') {
    return [sm.initial];
  }
  if (!sm.transitions || !Array.isArray(sm.transitions[current])) return [];
  return sm.transitions[current].slice();
}

/**
 * Convention for the virtual key emitted onto records:
 *   status            → statusAvailableTransitions
 *   paymentStatus     → paymentStatusAvailableTransitions
 *
 * Multi-state-machine schemas don't collide because the virtual is
 * keyed off the field name, not a generic 'availableTransitions'.
 */
const availableTransitionsKey = (fieldName) =>
  `${fieldName}AvailableTransitions`;

/**
 * Mutate `records` to attach `<field>AvailableTransitions` per
 * state-machine field. No-op when the schema has no state machines.
 */
function attachAvailableTransitions(records, schema) {
  const sms = stateMachineFieldsOf(schema);
  if (!sms.length || !Array.isArray(records) || records.length === 0) return records;
  for (const r of records) {
    if (!r) continue;
    for (const f of sms) {
      r[availableTransitionsKey(f.name)] = computeAvailableTransitions(
        f,
        r[f.name]
      );
    }
  }
  return records;
}

/**
 * Stamp the initial value for every state-machine field on a
 * create payload. The server is the source of truth here —
 * clients can't enter a record at any state but `initial`.
 */
function stampInitialStates(data, schema) {
  if (!data) return data;
  for (const f of stateMachineFieldsOf(schema)) {
    data[f.name] = f.stateMachine.initial;
  }
  return data;
}

/**
 * Produce a list of `{ field, current, next }` descriptors for
 * every state-machine field that's actually changing in this
 * update. Fields not present on `writable` are skipped (no-op
 * updates don't fire transitions).
 */
function listTransitionsToValidate(writable, beforeRecord, schema) {
  const out = [];
  for (const f of stateMachineFieldsOf(schema)) {
    if (!Object.prototype.hasOwnProperty.call(writable, f.name)) continue;
    const next = writable[f.name];
    const current = beforeRecord ? beforeRecord[f.name] : undefined;
    if (current === next) continue;
    out.push({ field: f, current, next });
  }
  return out;
}

module.exports = {
  isStateMachineField,
  stateMachineFieldsOf,
  validateTransition,
  computeAvailableTransitions,
  availableTransitionsKey,
  attachAvailableTransitions,
  stampInitialStates,
  listTransitionsToValidate,
};
