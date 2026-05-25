# davepi-plugin-postmark

Transactional email for [dAvePi][davepi] via [Postmark][postmark]. Exposes
`sendEmail` and `sendTemplate` so a [schema lifecycle hook][hooks] can
fire a welcome / receipt / password-reset email inline, and optionally
subscribes to the in-process record event bus to auto-send a template
for every CRUD event whose type matches a configured pattern.

[davepi]: https://docs.davepi.dev
[postmark]: https://postmarkapp.com/developer
[hooks]: https://docs.davepi.dev/features/hooks/

## Install

```bash
npm install davepi-plugin-postmark
```

Add it to your project's `package.json` under `davepi.plugins`:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-postmark"]
  }
}
```

## Configure

All config is env-driven:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTMARK_SERVER_TOKEN`   | yes (otherwise dormant) | — | The server token from your Postmark server. Used in the `X-Postmark-Server-Token` header. |
| `POSTMARK_FROM`           | strongly recommended | — | Default `From` address. Can be `name@example.com` or `"Acme <name@example.com>"`. Per-call `from` overrides this. |
| `POSTMARK_REPLY_TO`       | no | — | Default `Reply-To` address. Per-call `replyTo` overrides this. |
| `POSTMARK_MESSAGE_STREAM` | no | (Postmark uses `outbound`) | Default Postmark message stream. Set to your transactional stream's ID. |
| `POSTMARK_APP_NAME`       | no | dAvePi's `APP_NAME` env var, then `"dAvePi"` | Surfaced to rule `build()` callbacks as `{ appName }` and useful for logging. |

A missing `POSTMARK_SERVER_TOKEN` is intentional: the plugin logs a
warning and stays dormant. `sendEmail` / `sendTemplate` will throw if
called in that state. This lets you ship the plugin in a project that
hasn't wired Postmark yet without crashing boot.

A malformed `POSTMARK_FROM` (e.g. `Acme Co` with no `@`) is rejected
at boot — the plugin stays dormant and logs an error. Better to catch
the typo at startup than during the first send.

### Inbound webhook (optional)

If you want Postmark's inbound parsing — replies threading back to a
ticket record, contact-form intake, mail-to-record bridges — set both:

| Variable | Description |
|----------|-------------|
| `POSTMARK_INBOUND_PATH` | The Express path to mount the inbound POST handler at, e.g. `/webhooks/postmark/inbound`. |
| `POSTMARK_INBOUND_AUTH` | A `user:pass` pair the plugin will require as HTTP Basic on every request. Configure the same pair in Postmark's dashboard as `https://user:pass@yourdomain/<path>`. |

Setting only one of the two logs an error and leaves the route
unmounted — an unauthenticated public POST endpoint that fans out to
your app's handlers would be a foot-cannon, so this is intentional.

See *Reacting to inbound mail* below for the consumer API.

## Calling Postmark from a hook

The primary API. Most apps want welcome / receipt / verification email
to be a side-effect of a specific record mutation, with all the
record's fields available to the template.

```js
// schema/versions/v1/user.js
const postmark = require('davepi-plugin-postmark');

module.exports = {
  path: 'user',
  collection: 'user',
  fields: [/* ... */],
  hooks: {
    afterCreate: async ({ record, req }) => {
      try {
        await postmark.sendTemplate({
          to: record.email,
          templateAlias: 'welcome',
          templateModel: {
            name: record.name,
            verifyUrl: `https://app.example.com/verify/${record.verifyToken}`,
          },
        });
      } catch (err) {
        (req?.log || console).error({ err }, 'afterCreate welcome email failed');
      }
    },
  },
};
```

The `try/catch` is the convention for `after*` hooks — they're
best-effort, and dAvePi swallows throws to keep responses fast. Wrap
locally so a Postmark outage doesn't lose its diagnostic trail. See
[Hooks › Calling a plugin from a hook][hooks-call].

[hooks-call]: https://docs.davepi.dev/features/hooks/#calling-a-plugin-from-a-hook

## API

```js
const postmark = require('davepi-plugin-postmark');

// Plain email (HTML and/or text body).
await postmark.sendEmail({
  to: 'user@example.com',          // or ['a@x.com', 'b@x.com']
  subject: 'Welcome',
  htmlBody: '<p>Hi</p>',
  textBody: 'Hi',                  // at least one of htmlBody / textBody is required
  from: 'team@example.com',        // optional; defaults to POSTMARK_FROM
  cc:  'manager@example.com',
  bcc: ['ops@example.com'],
  replyTo: 'support@example.com',
  tag: 'welcome',
  metadata: { plan: 'pro' },
  headers: [{ Name: 'X-Source', Value: 'davepi' }],
  attachments: [{ Name: 'invite.ics', Content: '...base64...', ContentType: 'text/calendar' }],
  trackOpens: true,
  trackLinks: 'HtmlOnly',          // 'None' | 'HtmlAndText' | 'HtmlOnly' | 'TextOnly'
  messageStream: 'outbound',
});

// Templated email (created in the Postmark UI). `sendEmailWithTemplate`
// is the canonical name (matches Postmark's /email/withTemplate
// endpoint); `sendTemplate` is a short alias — both are the same
// function.
await postmark.sendEmailWithTemplate({
  to: 'user@example.com',
  templateAlias: 'welcome',        // or templateId: 12345
  templateModel: { name: 'Dave', verifyUrl: '...' },
  inlineCss: true,                 // optional
  // ... same optional overrides as sendEmail
});

// Batch sends — up to 500 messages per call (Postmark limit).
await postmark.sendBatch([
  { to: 'a@x.com', subject: 'one', textBody: '1' },
  { to: 'b@x.com', subject: 'two', textBody: '2' },
]);
await postmark.sendBatchTemplates([
  { to: 'a@x.com', templateAlias: 'welcome', templateModel: { name: 'A' } },
  { to: 'b@x.com', templateAlias: 'welcome', templateModel: { name: 'B' } },
]);
```

All four return Postmark's parsed JSON response. `sendEmail` /
`sendEmailWithTemplate` throw on transport error, non-2xx response, or
a 200 response with `ErrorCode !== 0`. The batch endpoints return
Postmark's array of per-message results unchanged — Postmark allows
partial success, so the caller decides how to handle failed entries.

## Reacting to inbound mail

When `POSTMARK_INBOUND_PATH` and `POSTMARK_INBOUND_AUTH` are set (see
*Configure › Inbound webhook* above), the plugin mounts the configured
route on the dAvePi Express app. The route:

1. Requires HTTP Basic with the configured `user:pass` (constant-time compare).
2. Validates that the body looks like a Postmark [InboundMessage][postmark-inbound] (`MessageID` + `From` present).
3. ACKs Postmark with `200 { ok: true, MessageID }` *immediately*.
4. Fans out to every registered handler via `setImmediate`. Handler errors are logged via the framework's pino instance and **never** trigger a Postmark retry — Postmark retries are for transport, not application failures, so a slow/broken subscriber must not create a thundering herd.

[postmark-inbound]: https://postmarkapp.com/developer/user-guide/inbound/parse-an-email

Register a handler:

```js
const postmark = require('davepi-plugin-postmark');

// Returns an unsubscribe function.
const off = postmark.onInboundEmail(async (msg) => {
  // msg is Postmark's full InboundMessage:
  //   { MessageID, From, FromName, To, Cc, Bcc, Subject,
  //     TextBody, HtmlBody, StrippedTextReply, Attachments,
  //     Headers, MessageStream, Date, ... }

  const ticketId = parseTicketTag(msg.To);     // e.g. inbox+ticket-42@my-app.com
  if (!ticketId) return;

  await TicketReply.create({
    ticketId,
    from: msg.From,
    text: msg.StrippedTextReply || msg.TextBody,
    receivedAt: new Date(msg.Date || Date.now()),
    postmarkMessageId: msg.MessageID,
  });
});
```

Idiomatic place for the subscription is a [plugin][davepi-plugins] of
your own — it gets the live app + bus during `setup()`, and any
multi-tenant routing logic (parsing `To` addresses, looking up
accounts) belongs alongside the rest of the app's cross-cutting code:

```js
// plugins/inbound-mail.js
const postmark = require('davepi-plugin-postmark');

module.exports = {
  name: 'inbound-mail',
  async setup({ schemaLoader, log }) {
    postmark.onInboundEmail(async (msg) => {
      try {
        // ...your routing logic here...
      } catch (err) {
        log.error({ err, messageId: msg.MessageID }, 'inbound mail handler failed');
      }
    });
  },
};
```

[davepi-plugins]: https://docs.davepi.dev/features/plugins/

### Multi-tenant routing

Postmark forwards every inbound email to the same URL — the plugin
can't infer which tenant it belongs to. The standard pattern is to
embed the tenant in the recipient address:

- **Subaddressing**: `support+account-<accountId>@your-domain.com` — Postmark preserves the full address in `msg.OriginalRecipient`.
- **Per-tenant inbound domains**: each account gets its own subdomain (`acme.inbound.your-app.com`); set up a Postmark mail server per domain, or run a single inbound and parse the recipient.

Either way, the handler is responsible for the lookup and for stamping
the resulting record with the correct `userId` / `accountId` so the
multi-tenant invariants in the rest of the framework still hold.

### Body-size limits

dAvePi mounts `express.json()` globally at the framework's default
limit. Postmark inbound payloads can be up to 35MB when attachments
are included (base64-encoded), so if you expect large attachments
bump the JSON limit in your `app.js` initialization (or, in a
consumer project, via a plugin that re-mounts a larger
`express.json({ limit: '40mb' })` ahead of the inbound route).

## Event-driven auto-send (optional)

If you want "fire a template every time event X happens" without
adding a hook to every schema, register rules via the `createPlugin`
factory:

```js
// plugins/welcome-on-signup.js
const { createPlugin } = require('davepi-plugin-postmark');

module.exports = createPlugin({
  rules: [
    {
      events: 'user.created',          // or ['user.created', 'invite.accepted']
      build: (event, { appName }) => {
        const email = event.record && event.record.email;
        if (!email) return null;       // returning null skips this event
        return {
          to: email,
          templateAlias: 'welcome',
          templateModel: { name: event.record.name, app: appName },
        };
      },
    },
  ],
});
```

Then in `package.json`:

```json
{
  "davepi": {
    "plugins": ["./plugins/welcome-on-signup.js"]
  }
}
```

Event patterns (identical to dAvePi's built-in [outbound webhooks][docs-webhooks]):

| Pattern | Matches |
|---------|---------|
| `user.created`   | Exact event type. |
| `user.*`         | Every `user.<verb>` event (`created`, `updated`, `deleted`, `transitioned`). |
| `*`              | Every event the framework emits. |

Pure-env auto-send is intentionally not supported: emails need a
recipient and a template, both of which depend on the record's
fields, so the rule has to be code.

[docs-webhooks]: https://docs.davepi.dev/features/webhooks/

## Failure handling

- **Rule subscriber** (event-driven): every send is wrapped in `try/catch`. A Postmark outage logs an `error` row via the framework's pino instance and is otherwise silent — the request loop is never blocked.
- **`sendEmail` / `sendTemplate`** (ad-hoc): errors propagate to the caller. The convention is to call them from an `after*` hook and wrap in `try/catch` so the hook doesn't surface an `unhandledRejection`.
- **Boot**: a missing `POSTMARK_SERVER_TOKEN` logs a warning and leaves the plugin dormant; a malformed `POSTMARK_FROM` logs an error and stays dormant. Boot does **not** fail — that would be a footgun in CI / staging where Postmark is intentionally unset.

Errors carry `status` and `errorCode` properties so operators can grep
without re-parsing the message:

```js
try {
  await postmark.sendEmail({ ... });
} catch (err) {
  if (err.errorCode === 406) /* "Inactive recipient" */ markUserUnreachable();
  else throw err;
}
```

See [Postmark API error codes][postmark-errors] for the full list.

[postmark-errors]: https://postmarkapp.com/developer/api/overview#error-codes

## Why not [outbound webhooks][docs-webhooks] for this?

The framework's webhook dispatcher delivers per-tenant subscriptions to
arbitrary URLs with HMAC signing and exponential-backoff retries —
right tool for "tenant X wants their own webhook." It's the wrong tool
for transactional email: you need a templating system, a sender
reputation, and bounce / open / click tracking, all of which Postmark
provides and a generic webhook does not.

## License

ISC
