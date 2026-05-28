# davepi-plugin-queue

Durable background jobs for [dAvePi][davepi] via [BullMQ][bullmq].
`after*` schema hooks run synchronously to the request, which is the
right answer for fast in-process side-effects (an audit row, a cache
invalidate) and the wrong answer the moment a hook needs to send a
Postmark email, hit Stripe, regenerate a PDF, or call an LLM. This
plugin gives every hook a `bus.emit('job:enqueue', ...)` channel — or
a direct `enqueue()` import — that returns immediately, runs the job
in the background, retries with exponential backoff on failure, and
survives a process restart because BullMQ persists everything in
Redis.

[davepi]:  https://docs.davepi.dev
[bullmq]:  https://docs.bullmq.io/
[hooks]:   https://docs.davepi.dev/features/hooks/

## Install

```bash
npm install davepi-plugin-queue
```

You also need a Redis instance the app can reach. Heroku Key-Value
Store, Upstash, AWS ElastiCache, fly.io's Redis add-on, and a plain
self-hosted `redis-server` all work — BullMQ talks the standard Redis
protocol, no managed-service quirks. Without `QUEUE_REDIS_URL` the
plugin is **dormant**: it logs a warning at boot, `enqueue()` throws,
the status route isn't mounted. This makes the plugin safe to depend
on in a project that hasn't wired Redis yet.

Add it to your project's `package.json` under `davepi.plugins`:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-queue"]
  }
}
```

## Configure

All config is env-driven:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `QUEUE_REDIS_URL`   | yes (otherwise dormant) | — | `redis://` (or `rediss://`) connection string. |
| `QUEUE_NAME`        | no | `davepi` | BullMQ queue name. Lets multiple apps share a Redis instance without colliding. |
| `QUEUE_CONCURRENCY` | no | `5` | Per-worker concurrency. |
| `QUEUE_WORKER`      | no | `true` | When `false`, this process **only enqueues** — useful for splitting web and worker dynos. |
| `QUEUE_PREFIX`      | no | `bull` | BullMQ key prefix in Redis. |
| `QUEUE_STATUS_PATH` | no | `/api/jobs` | Empty string disables the status route entirely. |
| `QUEUE_FAILED_TTL`  | no | (forever) | How long terminally-failed jobs stick around before being swept. Accepts `7d`, `12h`, `30m`, `60s`, or a bare integer (ms). |

## A worked example: welcome email after signup

```js
// schema/versions/v1/user.js
const queue = require('davepi-plugin-queue');

module.exports = {
  path: 'user',
  fields: [
    { name: 'email', type: 'String', required: true },
    { name: 'name',  type: 'String' },
  ],
  hooks: {
    afterCreate: async ({ record, user }) => {
      await queue.enqueue('send-welcome', {
        email: record.email,
        name:  record.name,
      }, {
        user,                                   // ← tenancy stamp
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      });
    },
  },
};
```

```js
// plugins/welcome-handler.js — a consumer-side plugin that registers
// the worker-side of the `send-welcome` job.
const queue   = require('davepi-plugin-queue');
const postmark = require('davepi-plugin-postmark');

module.exports = {
  name: 'welcome-handler',
  async setup({ log }) {
    queue.registerJob('send-welcome', async (data, { attempt, log: jobLog }) => {
      jobLog.info({ attempt, email: data.email }, 'sending welcome email');
      await postmark.sendEmailWithTemplate({
        to: data.email,
        templateAlias: 'welcome',
        templateModel: { name: data.name },
      });
    });
  },
};
```

In `package.json`:

```json
{
  "davepi": {
    "plugins": [
      "davepi-plugin-postmark",
      "davepi-plugin-queue",
      "./plugins/welcome-handler.js"
    ]
  }
}
```

Now POST `/api/user` returns immediately. The Postmark call runs in
the background, retries up to five times with exponential backoff,
and lands as a `job.completed` event on the framework's `record` bus
where the audit plugin (or Slack, or Sentry) can observe it.

## Enqueueing without importing

If you'd rather not import the plugin module inside a schema file,
emit a `job:enqueue` event on the framework's `bus`:

```js
hooks: {
  afterCreate: async ({ record, user, req }) => {
    req.app.locals.bus.emit('job:enqueue', {
      name: 'send-welcome',
      data: { email: record.email, name: record.name },
      opts: { user, attempts: 5 },
    });
  },
}
```

The plugin subscribes to the same `bus` and picks up the event. This
keeps schema files free of plugin-specific imports — useful when a
schema might be loaded with or without the queue plugin installed
(it becomes a no-op when the queue is dormant).

## Rule-based auto-enqueue

A `createPlugin({ rules: [...] })` factory option subscribes to
`record:*` events and auto-enqueues one job per match:

```js
const { createPlugin } = require('davepi-plugin-queue');

module.exports = createPlugin({
  rules: [
    {
      events: 'order.created',
      build: (event) => ({
        name: 'capture-payment',
        data: { orderId: event.recordId, amount: event.record.total },
      }),
    },
    {
      events: 'user.*',
      build: (event) => {
        // Return null to skip this event (e.g. the record has no
        // email to send to).
        if (!event.record || !event.record.email) return null;
        return {
          name: 'audit-user-change',
          data: { userId: event.userId, change: event.type },
        };
      },
    },
  ],
});
```

Each rule has the same shape as
[`davepi-plugin-postmark`](https://www.npmjs.com/package/davepi-plugin-postmark)'s
rules. `events` is a string or array of patterns (`user.created`,
`user.*`, `*`). `build(event, { appName })` returns
`{ name, data, opts }` (or `null` to skip). The tenancy stamp is
resolved in this order, most specific first:

1. `built.opts.user` — explicit override stamped onto the BullMQ
   options.
2. `built.user`      — shorthand for stamping at the rule level.
3. `event.userId`    — default; inherits the tenant of the
   triggering record event.

Most rules omit all three and let `event.userId` flow through. Rule
subscribers are deliberately skipped for the plugin's own
`job.completed` / `job.failed` / `job.stalled` rebroadcasts — a
wildcard rule won't infinite-loop.

## Repeating jobs

For cron-style schedules, hand the underlying BullMQ `repeat`
option to `registerJob`:

```js
queue.registerJob('nightly-report', async () => {
  // ... generate report ...
}, {
  repeat: { pattern: '0 2 * * *' },     // every day at 02:00 UTC
});
```

The plugin schedules a sentinel job under the same name; BullMQ
handles the recurrence after that. The companion
[`davepi-plugin-cron`](https://github.com/projik/davepi/issues/115)
wraps the same primitive in a declarative `package.json` config —
use the queue plugin directly when you want full control, the cron
plugin when you want one-line declarations.

## Tenant-scoped status endpoint

`GET /api/jobs/:id` (path configurable via `QUEUE_STATUS_PATH`)
returns:

```json
{
  "id": "1234",
  "name": "send-welcome",
  "status": "completed",
  "attempts": 1,
  "lastError": null,
  "returnValue": null,
  "progress": 0
}
```

Multi-tenant: the plugin stamps `userId` (and `accountId` when
present) onto `job.data` at enqueue time. The status route refuses
to return a job whose stamped `userId` doesn't match
`req.user.user_id` — same invariant as every auto-generated route in
the framework. A cross-tenant lookup gets a plain `404` rather than
`403`, so you can't probe for job IDs that belong to other tenants.

The route is mounted behind the framework's `auth(true)` middleware:
clients without a Bearer token get the canonical
`{ error: { code, message } }` 401/403 shape.

## Web vs worker split

By default the same Node process is both enqueuer and worker. As
load grows BullMQ's worker can get event-loop heavy; the standard
play is to split:

| Dyno | `QUEUE_WORKER` |
|------|----------------|
| web  | `false`        |
| worker | `true` (default) |

Both processes load the plugin with the same `QUEUE_REDIS_URL` /
`QUEUE_NAME` / `QUEUE_PREFIX`. The web dyno only enqueues and
responds to `/api/jobs/:id`; the worker dyno processes. Handlers are
registered in the consumer's own plugin; if you load it on both
processes the same code path works for both.

## Footguns

- **Pass plain objects, not Mongoose documents, to `enqueue`.** BullMQ
  JSON-serialises the payload before storing in Redis; a Mongoose
  document has methods + internal state that don't round-trip, and
  the worker handler receives `{}`. Spread to a POJO
  (`{ ...record.toObject() }`) or pick the fields you need.
- **Bulk paths intentionally do NOT invoke schema hooks.** The
  framework docs spell this out; if you need a reaction on a bulk
  write, subscribe to the `record` bus (or use a rule) rather than
  putting the logic in a hook.
- **`enqueue` requires a tenancy stamp.** Pass `{ user: req.user }`
  in `opts`, or include `userId` directly in `data`. System-wide
  jobs without a tenant should pass an explicit
  `{ user: { user_id: 'system' } }` — refusing at enqueue time is
  the safer default than letting unscoped jobs slip past the status
  endpoint's tenant check.
- **Redis is a new infra requirement.** Dormant-mode keeps the
  plugin safe to depend on, but `enqueue()` throws when called
  without `QUEUE_REDIS_URL`. Tests that exercise enqueue should
  inject `bullmq: { Queue, Worker }` stubs via `createPlugin`.

## Comparison with the in-tree audit / webhook fan-out

The framework already emits every CRUD mutation as a `record` bus
event. The webhook dispatcher (and `davepi-plugin-audit`) subscribe
to that bus synchronously. The queue plugin doesn't replace either —
it's the durable counterpart:

- **Audit / webhooks:** synchronous to the request, fire-and-forget,
  no retry, no persistence past process exit. Fine for "record this
  happened", wrong for "send an email."
- **Queue:** durable across process restarts, retries with backoff,
  decoupled latency. Right answer for slow side-effects.

You'll usually want both: audit captures *that* an event happened;
queue defers the slow follow-up.
