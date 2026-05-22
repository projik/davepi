# davepi-plugin-slack

[Slack incoming-webhook][slack-webhooks] notifications for [dAvePi][davepi].
Subscribes to the in-process record event bus and posts a message to
your Slack channel for every CRUD event whose type matches a
configured pattern. Also exposes `postMessage` so a [schema lifecycle
hook][hooks] can fire a custom Slack message inline.

[davepi]: https://docs.davepi.dev
[hooks]: https://docs.davepi.dev/features/hooks/
[slack-webhooks]: https://api.slack.com/messaging/webhooks

## Install

```bash
npm install davepi-plugin-slack
```

Add it to your project's `package.json` under `davepi.plugins`:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-slack"]
  }
}
```

## Configure

All config is env-driven:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_WEBHOOK_URL`   | yes (otherwise dormant) | — | The full incoming-webhook URL Slack handed you when you created the integration. Must be `https://`. |
| `SLACK_EVENTS`        | no | (empty — no auto-forward) | Comma-separated event patterns. Supports `order.created`, `order.*`, and `*`. |
| `SLACK_APP_NAME`      | no | dAvePi's `APP_NAME` env var, then `"dAvePi"` | The prefix the default formatter uses in every message. |
| `SLACK_USERNAME`      | no | — | Optional sender name override. |
| `SLACK_ICON_EMOJI`    | no | — | Optional sender icon (e.g. `:robot_face:`). |

A missing `SLACK_WEBHOOK_URL` is intentional: the plugin logs a
warning and stays dormant. `postMessage` will throw if called in that
state. This lets you ship the plugin in a project that hasn't wired
Slack yet without crashing boot.

## Event patterns

| Pattern | Matches |
|---------|---------|
| `order.created` | Exact event type. |
| `order.*` | Every `order.<verb>` event (`created`, `updated`, `deleted`, `transitioned`). |
| `*` | Every event the framework emits. |

The patterns are identical to dAvePi's built-in [outbound
webhooks][docs-webhooks], so the same `SLACK_EVENTS` value you'd put
in a webhook subscription works here too.

[docs-webhooks]: https://docs.davepi.dev/features/webhooks/

## What gets posted

For a single-record event:

> *my-app* — `order.created` — `66e8b3...`

For a bulk event (bulk PUT / GraphQL `updateMany`):

> *my-app* — `order.updated` — 42 record(s) affected

For a state-machine transition:

> *my-app* — `order.transitioned` — `66e8b3...` — status: draft → approved

Want a richer payload (block-kit cards, mentions, channel routing)?
Override the default formatter — see "Advanced" below.

## Calling Slack from a hook

```js
// plugins/postmark.js  (your other plugin)
// ... runs setup, exports sendEmail ...
```

```js
// schema/versions/v1/user.js
const slack = require('davepi-plugin-slack');
const postmark = require('#plugins/postmark');

module.exports = {
  path: 'user',
  collection: 'user',
  fields: [/* ... */],
  hooks: {
    afterCreate: async ({ record, req }) => {
      try {
        await postmark.sendEmail({ to: record.email, subject: 'Welcome', body: '...' });
        await slack.postMessage(`:tada: signup — ${record.email}`);
      } catch (err) {
        (req?.log || console).error({ err }, 'afterCreate side-effects failed');
      }
    },
  },
};
```

The `try/catch` is the convention for `after*` hooks — they're
best-effort, and dAvePi swallows throws to keep responses fast. Wrap
locally so a Slack outage doesn't lose its diagnostic trail. See
[Hooks › Calling a plugin from a hook][hooks-call].

[hooks-call]: https://docs.davepi.dev/features/hooks/#calling-a-plugin-from-a-hook

## Advanced

`require('davepi-plugin-slack')` returns a default instance reading
config from `process.env`. Use the `createPlugin` factory if you want
to inject a custom formatter, fetch implementation, or env source:

```js
const { createPlugin } = require('davepi-plugin-slack');

module.exports = createPlugin({
  // Slack accepts richer payloads — return blocks instead of text.
  formatter: (event, { appName }) => `:warning: [${appName}] ${event.type}`,
  // Pin a request timeout (default 10s).
  timeoutMs: 5000,
});
```

Then in `package.json`:

```json
{
  "davepi": {
    "plugins": ["./plugins/my-slack.js"]
  }
}
```

## Failure handling

- **Bus subscriber**: every post is wrapped in `try/catch`. A Slack outage logs an `error` row via the framework's pino instance and is otherwise silent — the request loop is never blocked.
- **`postMessage` (ad-hoc)**: errors propagate to the caller. The convention is to call it from an `after*` hook and wrap in `try/catch` so the hook doesn't surface an `unhandledRejection`.
- **Boot**: a missing / malformed `SLACK_WEBHOOK_URL` logs once and leaves the plugin dormant. Boot does **not** fail — that would be a footgun in CI / staging where Slack is intentionally unset.

## Why not [outbound webhooks][docs-webhooks] for this?

The framework's webhook dispatcher delivers a per-tenant subscription
to an arbitrary URL with HMAC signing and exponential-backoff retries
— exactly the right tool for "tenant X wants their own webhook." It
isn't the right tool for "operator wants Slack to ping when anything
mutates," which is what this plugin is for:

- **One Slack channel for the whole app**, not one per tenant.
- **Operator-controlled** via env, not per-user subscriptions managed in Mongo.
- **No HMAC, no per-tenant secret rotation** — Slack incoming webhooks are their own URL-as-secret.
- **No retry queue** — Slack outages are visible in operator logs, and the next event will go through.

If you also want per-tenant Slack alerts (e.g. "tenant Y subscribes to
their own order.created events"), use the in-tree webhook dispatcher
instead — it's purpose-built for that.

## License

ISC
