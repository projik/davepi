---
title: State machines
description: Declarative finite-state machines on schema fields — invalid transitions become 400 INVALID_TRANSITION, hooks run on enter, audit and webhooks track every transition.
---

A state-machine field is a `String` field with an extra
`stateMachine` config. The framework stamps the initial state on
create, validates every change against the declared transitions,
runs `onEnter` hooks, writes audit rows, emits webhooks, and
exposes a `transition` action across REST, GraphQL, MCP, and the
typed client.

## Declaration

```js
{
  name: 'status',
  type: String,
  stateMachine: {
    initial: 'draft',
    states: ['draft', 'review', 'approved', 'rejected', 'archived'],
    transitions: {
      draft:    ['review', 'archived'],
      review:   ['approved', 'rejected'],
      approved: ['archived'],
      rejected: ['draft'],
    },
    onEnter: {
      approved: async (record, ctx) => {
        // Side effect, e.g. send notification.
      },
    },
  },
}
```

| Sub-key | Description |
|---------|-------------|
| `initial` | Stamped server-side on POST. Clients cannot pick a non-initial state on create. |
| `states` | Required array. Becomes a literal union in the typed client. |
| `transitions` | Map of `current -> allowed nexts`. |
| `onEnter` | Map of `state -> async (record, ctx)`. Runs once per arrival. Errors are logged, never fail the mutation. |

Multiple state-machine fields per schema operate independently —
everything is per-field, not per-schema.

## What the framework enforces

| Operation | Behaviour |
|-----------|-----------|
| POST | `initial` is stamped. Client values for the SM field are ignored. |
| PUT / GraphQL update / MCP update | Each declared transition is validated against `transitions[current]`. Anything else surfaces as `400 INVALID_TRANSITION`. |
| Audit | Each successful transition writes a row with `action: 'transition'`, the old and new state, the actor's `userId`, and the field name. |
| Webhooks | Emits a `<path>.transitioned` event in addition to the regular `updated`. |
| `onEnter[state]` | Runs once per arrival, with `(record, ctx)`. Best-effort: errors logged, never fail. |
| `availableTransitions` | Virtual attached on every read so clients render the right action buttons without re-parsing the schema. |

## INVALID_TRANSITION shape

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Cannot transition status from 'review' to 'archived'",
    "details": {
      "field":    "status",
      "current":  "review",
      "attempted": "archived",
      "allowed":  ["approved", "rejected"]
    }
  }
}
```

Agents that read `details.allowed` can self-correct. The typed
client's `DavepiError` exposes the same shape.

## REST

Drive a transition by sending the new value through the standard
update route. The framework validates the move before persisting:

```http
PUT /api/v1/quote/abc
{ "status": "review" }
```

There's no separate action endpoint — transitions go through the same
PUT that any other field update would use.

## GraphQL

A dedicated `<path>Transition<Field>(_id, to)` mutation is generated
per state-machine field. The `to` argument is typed as the schema's
generated enum, so a typo on the wire is caught at validation time:

```graphql
mutation {
  quoteTransitionStatus(_id: "abc", to: review) {
    record { _id, status, availableTransitions { status } }
  }
}
```

The standard `quoteUpdateById` resolver also validates against the
state machine when the field is set — the dedicated mutation is
preferred, but you can't bypass the transition graph through it.

## MCP

There's no dedicated transition tool. Send the new value through
`update_<path>` — the framework runs the same validation:

```json
{
  "name": "update_quote",
  "arguments": { "id": "abc", "record": { "status": "review" } }
}
```

## Typed client

```ts
await api.quote.transitionStatus(id, 'review');
//                                    ^^^^^^^^
// 'review' is typed as a literal union of allowed states
```

The compiler catches typos: `transitionStatus(id, 'reveiw')` is a
red squiggle.

## `availableTransitions` on every read

```json
{
  "_id": "abc",
  "status": "review",
  "availableTransitions": {
    "status": ["approved", "rejected"]
  }
}
```

Clients render the right buttons without reading the schema. The
shape is keyed by field name, so a record with two state-machine
fields gets two arrays.

## `onEnter` hooks

```js
onEnter: {
  approved: async (record, ctx) => {
    await ctx.events.emit('quote.approved', { id: record._id });
    await sendApprovalEmail(record);
  },
},
```

`ctx` carries `{ user, log, events, models, schema }` so the hook
can do anything a regular handler does. Errors are logged but
don't fail the mutation — same posture as audit. If a hook
**must** succeed before the transition is acknowledged, do the work
in a custom route that wraps the transition.

## Multiple state machines

A single schema can have multiple state-machine fields. Each is
independent:

```js
fields: [
  { name: 'editorialStatus', type: String, stateMachine: { /* ... */ } },
  { name: 'fulfillmentStatus', type: String, stateMachine: { /* ... */ } },
],
```

Each gets its own `transitionEditorialStatus` / `transitionFulfillmentStatus`
typed client method, its own action route, its own MCP tool, and
its own slot in `availableTransitions`.

## See also

- [Field options](/reference/fields/#state-machine) — declaration reference.
- [Audit log](/features/audit/) — each transition writes a row.
- [Webhooks](/features/webhooks/) — `<path>.transitioned` events.
- [Errors](/reference/errors/) — full INVALID_TRANSITION payload.
