---
title: Lifecycle hooks
description: Per-resource beforeCreate / afterCreate / beforeUpdate / afterUpdate / beforeDelete / afterDelete hooks declared on the schema file.
---

A lifecycle hook is a function declared on a schema file that runs
around the framework's persist step. Use a hook when the side
effect or invariant belongs to **one** resource — validating a
field combination before save, generating a derived value, sending
a welcome email on create, refusing a delete while dependents
exist.

For cross-resource side effects (audit fan-out, integrations
that span every schema), use a [plugin](/features/plugins/)
instead.

## Declaration

Add a `hooks` block to the schema's top-level export. Every key is
optional — declare only what you need.

```js
const { ForbiddenError, ValidationError } = require('davepi/utils/errors');

module.exports = {
  path: 'order',
  collection: 'order',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'accountId', type: String, required: true },
    { name: 'code',  type: String, required: true },
    { name: 'total', type: Number },
    { name: 'status', type: String },
  ],
  hooks: {
    beforeCreate: async ({ input, user, req, schema }) => {
      if (input.total < 0) throw new ValidationError('total must be non-negative');
      return { ...input, code: generateCode() };
    },
    afterCreate: async ({ record, user, req, schema }) => {
      await sendOrderConfirmation(record);
    },
    beforeUpdate: async ({ input, current, user, req, schema }) => {
      if (current.status === 'closed') {
        throw new ForbiddenError('closed orders are read-only');
      }
      return input;
    },
    afterUpdate: async ({ record, previous, user, req, schema }) => {
      if (record.total !== previous.total) {
        await recalculateInvoice(record);
      }
    },
    beforeDelete: async ({ current, user, req, schema }) => {
      const dependents = await Invoice.countDocuments({ orderId: current._id });
      if (dependents > 0) throw new ForbiddenError('order has invoices');
    },
    afterDelete: async ({ record, user, req, schema }) => {
      await notifyAccounting(record);
    },
  },
};
```

## The six hook slots

| Hook | Fires when | Receives | Posture |
|------|-----------|----------|---------|
| `beforeCreate` | Just before the insert. Server-stamped `userId` / `accountId` and any state-machine initial state are already present on `input`. | `{ input, user, req?, schema }` | Sync. Return-value replaces input. Throw to reject. |
| `afterCreate` | After insert, after the response is built, before it's sent. | `{ record, user, req?, schema }` | Best-effort. Throws are logged. |
| `beforeUpdate` | Just before the `$set`. Filtered through ACL writability first. | `{ input, current, user, req?, schema }` | Sync. Return-value replaces input. Throw to reject. |
| `afterUpdate` | After persistence, with both the old and new record. | `{ record, previous, user, req?, schema }` | Best-effort. Throws are logged. |
| `beforeDelete` | After the record is fetched, before the delete/tombstone. | `{ current, user, req?, schema }` | Sync. Throw to reject. |
| `afterDelete` | After delete (or soft-delete tombstone), before the response. | `{ record, user, req?, schema }` | Best-effort. Throws are logged. |

### Context fields

| Field | Type | Notes |
|-------|------|-------|
| `input` | object | The about-to-be-persisted payload (`beforeCreate` / `beforeUpdate` only). Already ACL-filtered and tenant-stamped. Returning a new object **replaces** it; returning `undefined` keeps it as-is. |
| `current` | object | The lean Mongo document as it exists right now (`beforeUpdate` / `beforeDelete`). |
| `record` | object | The persisted document, ACL-projected through the actor's roles (`afterCreate` / `afterUpdate` / `afterDelete`). |
| `previous` | object | The document as it was before the update (`afterUpdate` only). |
| `user` | object | The authenticated user from the JWT — `{ user_id, email, roles, ... }`. |
| `req` | object | The Express request, when REST is the caller. `undefined` under GraphQL. Use it for `req.log`, `req.headers`, `req.ip`, etc. |
| `schema` | object | The full schema definition (for hooks shared across resources via a helper). |

## Returning vs. mutating

```js
beforeCreate: async ({ input }) => {
  return { ...input, code: generateCode() };   // recommended
}

beforeCreate: async ({ input }) => {
  input.code = generateCode();                 // also works, but in-place mutation
  // (no return: framework keeps the mutated input)
}
```

Both are honoured. Returning a new object is the safer pattern —
it composes well when one hook calls another, and it makes the
intent of a hook visible in its signature.

Returning `undefined` keeps the input the framework already had.
Returning `null` is **not** a special signal; it would replace the
input with `null` and crash the insert. Stick to returning an
object or returning nothing.

## Rejecting an operation

Throw a typed error from `davepi/utils/errors`:

```js
const { ValidationError, ForbiddenError, ConflictError } = require('davepi/utils/errors');

beforeUpdate: async ({ input, current }) => {
  if (current.status === 'closed' && input.total !== current.total) {
    throw new ForbiddenError('cannot change total on a closed order');
  }
}
```

The error flows through the centralised
[errorHandler](/reference/errors/) and produces the standard JSON
shape:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "cannot change total on a closed order"
  }
}
```

| Error class | HTTP status | When |
|-------------|-------------|------|
| `ValidationError` | 400 | Client supplied something invalid. |
| `ConflictError` | 409 | Uniqueness collision (the framework also maps Mongo's `11000` to this). |
| `ForbiddenError` | 403 | Caller can't perform this action. |
| `NotFoundError` | 404 | Referenced resource missing. |

Throwing a plain `Error` works too — in production it surfaces as
`500 Internal server error`, which is rarely what you want.
Always pick the typed class.

`after*` hooks **never** reject the response. A throw inside an
`after*` is logged with `pino.warn` and swallowed — the same
posture as the audit writer and the state-machine `onEnter` hook.
Design `after*` hooks to be safely retryable from outside: if the
work absolutely must succeed, subscribe to the event bus from a
[plugin](/features/plugins/) and put the retry logic there.

## Surface coverage

Hooks fire on **single-record** paths only. The table is exhaustive:

| Surface | Fires hooks? | Notes |
|---------|-------------|-------|
| `POST /api/v1/<path>` | yes | `beforeCreate` then `afterCreate`. |
| `PUT /api/v1/<path>/:id` | yes | `beforeUpdate` then `afterUpdate`. State-machine validation runs **after** `beforeUpdate`, so a hook that rewrites the target state still gets validated. |
| `DELETE /api/v1/<path>/:id` | yes | `beforeDelete` then `afterDelete`. Fires for both soft-delete and hard-delete. |
| GraphQL `<path>CreateOne` | yes | Same shape as REST POST. |
| GraphQL `<path>UpdateById` | yes | Same shape as REST PUT-by-id. |
| GraphQL `<path>RemoveById` | yes | Same shape as REST DELETE. |
| **Bulk PUT** `/api/v1/<path>` | **no** | Operates on a server-side filter; per-record hooks would multiply work in surprising ways. |
| GraphQL `<path>CreateMany` | **no** | Bulk path. |
| GraphQL `<path>UpdateMany`, `<path>UpdateOne` | **no** | Operate on a filter, not a known `_id`. |
| GraphQL `<path>RemoveMany` | **no** | Bulk path. |
| State-machine transitions | partial | The state-machine path has its own `onEnter[<state>]` hook (see [State machines](/features/state-machines/)). `beforeUpdate` / `afterUpdate` still fire for REST `PUT /:id` transitions; the GraphQL `<path>Transition<Field>` mutation runs `onEnter` but **does not** run `beforeUpdate` / `afterUpdate`. |
| File-field uploads (`PUT /:id/<field>`) | no | Field-level. |
| File-field deletes (`DELETE /:id/<field>`) | no | Field-level. |

If you need to react to a bulk write, subscribe to the
[record event bus](/features/plugins/#event-bus) from a plugin —
the bus fires `<path>.updated` / `<path>.deleted` with a
`numAffected` payload for bulk paths.

## Composing hooks across schemas

There's no built-in "hook every schema" slot — that's a plugin's
job. But hooks can share a helper. Put it under `./lib/` and
require it via the `#lib/` subpath import alias every scaffolded
project ships with:

```js
// lib/audit-author.js
exports.recordAuthor = async ({ input, user }) => ({
  ...input,
  createdBy: user.user_id,
});
```

```js
// schema/versions/v1/note.js
const { recordAuthor } = require('#lib/audit-author');

module.exports = {
  path: 'note',
  collection: 'note',
  fields: [...],
  hooks: { beforeCreate: recordAuthor },
};
```

For anything that genuinely cross-cuts every resource (an audit
mirror, a third-party CRM sync), use a
[plugin](/features/plugins/) — it subscribes once to the event
bus and reacts to every CRUD event.

## Calling a plugin from a hook

A common pattern: you've written a plugin that wraps a third-party
client (Postmark, Slack, Stripe), and you want a per-resource hook
to call its exported helpers. Plugins are plain CommonJS modules,
so `require` them like any other helper — by convention, via the
`#plugins/` alias:

```js
// plugins/postmark.js
const { ServerClient } = require('postmark');

let client = null;

async function sendEmail({ to, subject, body }) {
  if (!client) throw new Error('postmark plugin not initialised');
  return client.sendEmail({ From: 'noreply@example.com', To: to, Subject: subject, TextBody: body });
}

module.exports = {
  name: 'postmark',
  async setup({ log }) {
    client = new ServerClient(process.env.POSTMARK_TOKEN);
    log.info({}, 'postmark client ready');
  },
  sendEmail,   // exported so hooks can call it
};
```

```js
// schema/versions/v1/user.js
const postmark = require('#plugins/postmark');

module.exports = {
  path: 'user',
  collection: 'user',
  fields: [...],
  hooks: {
    afterCreate: async ({ record, req }) => {
      try {
        await postmark.sendEmail({
          to: record.email,
          subject: 'Welcome!',
          body: `Hi ${record.firstName}, glad you're here.`,
        });
      } catch (err) {
        (req?.log || console).error({ err }, 'welcome email failed');
      }
    },
  },
};
```

Load ordering makes this safe: schema files are required at boot
(so the `require('#plugins/postmark')` resolves the module
exports immediately, with `client` still `null`); plugin `setup`
runs after the schema pass (initialising `client`); hooks only
fire on request handling, well after both. The `try/catch`
matters — `afterCreate` is best-effort, so wrap any third-party
call so a Postmark outage doesn't surface as a noisy
unhandledRejection.

## Hooks and tenant isolation

Hooks **do not** bypass tenant scoping. `user.user_id` is the
authenticated tenant; `input.userId` and `input.accountId` are
stamped before `beforeCreate` runs (and overwritten if you return
something different — the framework re-stamps after the hook, so
a malicious `beforeCreate: () => ({ userId: 'someone-else' })`
silently fails). The same applies to `beforeUpdate`.

If you need to write into another tenant's data from a hook (e.g.
a shared `webhook_log` collection), that's a code-smell signal —
write the helper at the model layer and call it from the hook.
Don't try to subvert the stamping.

## Performance

`before*` hooks block the request. Keep them cheap:

- Pure-CPU validation: trivial.
- One Mongo round-trip: fine.
- Multiple round-trips, network calls, third-party APIs: move to `after*` if possible.

`after*` hooks are awaited inline — they block the response too —
but their failures don't fail the request, so they're the right
place for unreliable side effects (email, third-party POSTs).
If the work is genuinely slow and can be deferred, fire-and-forget
it from the hook body:

```js
afterCreate: async ({ record, req }) => {
  // Don't await — let the response go out immediately.
  sendWelcomeEmail(record).catch((err) =>
    (req?.log || console).error({ err }, 'welcome email failed')
  );
}
```

The framework intentionally does not provide a job queue. If you
need durable retries, subscribe to the event bus from a
[plugin](/features/plugins/) and ship the event to your queue
of choice.

## What hooks do NOT see

- **`__include` relation population.** `record` in `after*` hooks is the persisted document, not the response with `__include` populated. Re-fetch the relations yourself if you need them.
- **ACL-stripped fields the actor can't read.** `afterCreate` / `afterUpdate` / `afterDelete` receive the record with the **actor's** read-ACL applied. A hook running on behalf of a non-admin user won't see `salary` if `salary` is admin-only on read.
- **Soft-delete restores.** `POST /:id/restore` doesn't fire `afterUpdate` (yet). It writes an audit row and emits a `<path>.updated` event; subscribe via a plugin if you need to react.

## See also

- [Plugins](/features/plugins/) — cross-cutting extensions, event-bus subscribers, custom routes that span resources.
- [State machines](/features/state-machines/) — `onEnter[<state>]` is the right place for transition-specific side effects.
- [Errors](/reference/errors/) — typed error classes you can throw from `before*` hooks.
- [Webhooks](/features/webhooks/) — outbound HTTP fan-out, often what an `afterCreate` would otherwise do by hand.
