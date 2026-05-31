---
title: 5. Multi-tenant bookings — the agent runs the business
description: Per-tenant data isolation, SMS reminders via Twilio, payments via Stripe, and the agent itself taking bulk actions with a human-approval gate.
---

You're building Calendly-for-salons. Each salon is a tenant. Each
tenant has staff, services, and appointments. Confirmations go
out via SMS. Payments come in via Stripe. And — this is the
mind-blower — you want your Slack bot to **take actions on your
behalf** after you approve them.

By the end you'll be DMing your bot *"send every customer with a
booking tomorrow at Salon A a 'looking forward to seeing you'
SMS — show me the list first"* and the bot fans out actual SMS
messages after you OK the list.

**You'll learn**: multi-tenant ACL with `accountId` scoping, the
Twilio + Stripe + Audit plugins composing on the event bus, the
agent's per-user auth mode (Slack identity → davepi user), the
tool router for large schemas, and the "approve first, then
execute" pattern.

**Time budget**: ~60 minutes. The longest tutorial in the series
and the one that ties everything together.

## 0:00 — Scaffold

```bash
npx create-davepi-app booking-platform --template b2b-saas
cd booking-platform
docker compose up -d
npm start
```

The `b2b-saas` template ships with `account`, `member`, and
`subscription` schemas that handle the multi-tenant skeleton.
We'll add domain-specific schemas on top.

## 3:00 — Four schemas

`schema/versions/v1/tenant.js`:

```js
module.exports = {
  path: 'tenant',
  collection: 'tenant',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'accountId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'timezone', type: String, default: 'America/New_York' },
    { name: 'phone', type: String },
  ],
};
```

`schema/versions/v1/staff.js`:

```js
module.exports = {
  path: 'staff',
  collection: 'staff',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'accountId', type: String, required: true },
    { name: 'tenantId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'email', type: String },
    { name: 'role', type: String, enum: ['stylist', 'colorist', 'manager'], required: true },
    { name: 'active', type: Boolean, default: true },
  ],
  relations: {
    tenant: { belongsTo: 'tenant', localKey: 'tenantId' },
  },
};
```

`schema/versions/v1/service.js`:

```js
module.exports = {
  path: 'service',
  collection: 'service',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'accountId', type: String, required: true },
    { name: 'tenantId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'duration_minutes', type: Number, required: true },
    { name: 'price_cents', type: Number, required: true },
    { name: 'description', type: String, searchable: true },
  ],
  relations: {
    tenant: { belongsTo: 'tenant', localKey: 'tenantId' },
  },
};
```

`schema/versions/v1/appointment.js`:

```js
module.exports = {
  path: 'appointment',
  collection: 'appointment',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'accountId', type: String, required: true },
    { name: 'tenantId', type: String, required: true },
    { name: 'staffId', type: String, required: true },
    { name: 'serviceId', type: String, required: true },
    { name: 'customer_name', type: String, required: true, searchable: true },
    { name: 'customer_email', type: String },
    { name: 'customer_phone', type: String, required: true },
    { name: 'scheduled_at', type: Date, required: true },
    { name: 'duration_minutes', type: Number, required: true },
    {
      name: 'status',
      type: String,
      enum: ['booked', 'reminded', 'completed', 'no_show', 'cancelled'],
      default: 'booked',
    },
    {
      name: 'payment_status',
      type: String,
      enum: ['unpaid', 'paid', 'refunded'],
      default: 'unpaid',
    },
    { name: 'stripe_session_id', type: String },
    { name: 'notes', type: String },
  ],
  relations: {
    tenant: { belongsTo: 'tenant', localKey: 'tenantId' },
    staff: { belongsTo: 'staff', localKey: 'staffId' },
    service: { belongsTo: 'service', localKey: 'serviceId' },
  },
  aggregations: [
    {
      name: 'utilisationByDay',
      description: 'Appointment count by tenant, per day, for capacity reporting.',
      pipeline: [
        {
          $group: {
            _id: {
              tenantId: '$tenantId',
              y: { $year: '$scheduled_at' },
              m: { $month: '$scheduled_at' },
              d: { $dayOfMonth: '$scheduled_at' },
            },
            count: { $sum: 1 },
            revenue_cents: { $sum: 0 },
          },
        },
        { $sort: { '_id.y': 1, '_id.m': 1, '_id.d': 1 } },
      ],
      cache: { ttlSeconds: 60 },
    },
  ],
};
```

Hot reload picks all four up. Every read in dAvePi is automatically
scoped by `userId` *and* `accountId` — see [Tenant
isolation](/concepts/tenancy/). A user from Tenant A querying
`/api/v1/appointment` never sees Tenant B's rows.

## 12:00 — Seed two salons

Register a user (you, the platform operator). Through the admin
UI, create two tenants — "Salon A" and "Salon B" — and 3 staff +
4 services + 6 appointments per tenant.

For Salon A's appointments, set 4 of them to `scheduled_at:
tomorrow` so the "send them all an SMS tomorrow" demo at the end
will hit real data.

Use real phone numbers — your own + a friend's — for at least two
appointments per tenant so the SMS demo lands. Otherwise use the
Twilio sandbox's verified numbers list.

## 18:00 — Twilio plugin: SMS confirmations + reminders

```bash
npm install davepi-plugin-twilio
```

`package.json`:

```json
{
  "davepi": {
    "plugins": [
      "davepi-plugin-twilio"
    ]
  }
}
```

`.env`:

```bash
# Twilio sandbox creds. Get from console.twilio.com.
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+15005550006     # sandbox magic number
# Optional: a messaging-service SID for production.
# TWILIO_MESSAGING_SERVICE_SID=MG...
```

Restart the davepi server. The plugin loads dormant if
`TWILIO_ACCOUNT_SID` is missing; it activates once you set it.
See [`davepi-plugin-twilio`](https://github.com/projik/davepi/tree/main/packages/davepi-plugin-twilio).

Now wire confirmations. Ask Claude:

> Add an `afterCreate` hook to appointment that uses the Twilio
> plugin's `sendSms` to text the customer a confirmation with
> the service name, time, and a reschedule link. Best-effort; if
> Twilio is down, log and continue.

Claude adds a hook that reaches the plugin via the framework's
plugin registry. After-hooks are best-effort (the response isn't
held on plugin failure — see [Hooks](/features/hooks/)).

Now wire reminders. Ask Claude:

> Add a cron schedule using `davepi-plugin-cron` that runs every
> 15 minutes, finds appointments scheduled within the next 24 hours
> and still in status `booked` (i.e. not yet `reminded`), sends a
> Twilio SMS reminder for each, and flips `status` to `reminded`.

This needs the cron plugin too:

```bash
npm install davepi-plugin-cron
```

Add to `package.json` plugins array and configure the cron block:

```json
{
  "davepi": {
    "plugins": [
      "davepi-plugin-cron",
      "davepi-plugin-twilio"
    ],
    "cron": {
      "appointmentReminders": {
        "schedule": "*/15 * * * *",
        "handler": "./plugins/appointment-reminders.js"
      }
    }
  }
}
```

Claude creates `plugins/appointment-reminders.js` with the
handler. The framework's cron plugin handles distributed locking
so you can run multiple dynos and only one sends each reminder.

## 28:00 — Stripe plugin: checkout + payment status

```bash
npm install davepi-plugin-stripe
```

`package.json` plugins array gains `davepi-plugin-stripe`.
`.env`:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_WEBHOOK_PATH=/api/webhooks/stripe
```

Wire the checkout flow. Ask Claude:

> Add a custom route `POST /api/checkout/appointment/:id` that
> creates a Stripe checkout session for that appointment's
> `service.price_cents`, stores the session id back on the
> appointment row, and returns the checkout URL. Hook the Stripe
> webhook so on `checkout.session.completed`, the appointment's
> `payment_status` flips to `paid`. Refuse the route for
> client-authed callers.

Claude adds the route + webhook handler. Restart davepi.

Test with the Stripe CLI:

```bash
stripe listen --forward-to localhost:5050/api/webhooks/stripe
```

Create an appointment through the UI, copy its id, then:

```bash
curl -X POST http://localhost:5050/api/checkout/appointment/$APT_ID \
  -H "Authorization: Bearer $TOKEN"
# → { "url": "https://checkout.stripe.com/c/pay/cs_test_..." }
```

Pay with the Stripe test card `4242 4242 4242 4242`. The webhook
fires, the appointment row's `payment_status` flips to `paid`, and
the [audit plugin](/features/audit/) (auto-loaded; see the
template's `package.json`) records the change.

## 36:00 — Wire the agent in per-user mode

This is the demo's most important auth choice. Previous tutorials
used **service-account** auth (one bearer for the whole bot).
Multi-tenant bookings demand **per-user** auth — Slack user A
should only see Salon A's data, not Salon B's. The agent maps
each Slack user to a real davepi user via Slack's signed event
identity.

```bash
npm install @davepi/agent
```

`.env.agent`:

```bash
DAVEPI_URL=http://localhost:5050
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Per-user mode — each Slack user is authed individually.
AGENT_AUTH_MODE=per-user
AGENT_LINK_BASE_URL=http://localhost:5060   # where the agent serves /link/:nonce
STORE_URL=file:./davepi-agent-store.json    # where refresh tokens persist
AGENT_SESSION_SECRET=$(openssl rand -hex 32)

# Tool router engages above 40 tools. With 4 resources × ~7 tools
# each plus aggregations and relation tools, you're past 40. Set
# the limit higher OR let the router engage — see Surfaces → Agent.
AGENT_TOOL_LIMIT=80

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_SOCKET_MODE=true
SLACK_APP_TOKEN=xapp-...
```

Register two davepi users (one for each salon's manager). In the
admin UI, set their `accountId` to point at their respective
salon's tenant.

Start:

```bash
set -a; source .env; source .env.agent; set +a
npx davepi-agent
```

## 42:00 — Link your Slack identity

DM the bot:

> Hi

The bot replies with a one-time link URL:

> *"You need to link your account first. Open this and sign in:
> http://localhost:5060/link/<nonce>"*

Click the link in your browser. A small login form appears. Enter
your salon manager's email + password. The agent calls davepi's
`POST /login` server-side, stores the refresh token in the
local file store, and shows a "Linked." page.

The browser **never** sees the refresh token — credentials POST,
token comes back to the agent, stored server-side only. See
[Surfaces → Agent → Auth](/surfaces/agent/#auth-modes).

Have a friend with a different Slack identity link to the other
salon's manager. Now you have two Slack users → two davepi users →
two tenants.

## 48:00 — Three Slack moments

**Moment 1 — read-only multi-tenant aggregation.**

Salon A's manager DMs:

> How many appointments are booked for tomorrow at my salon?

The agent calls `list_appointment` with a `scheduled_at` filter
for tomorrow. Because the JWT scopes to Tenant A's `accountId`,
the result *only* contains Tenant A's rows — the agent doesn't
know about Tenant B. The bot replies with a count + breakdown by
staff.

Have the other user (Salon B's manager) ask the same question.
Different answer, different rows. Same code, no per-tenant
branching anywhere.

**Moment 2 — double-booking detection.**

> Which staff at my salon are double-booked next week? Show me a
> table with the conflicts.

Agent calls `list_appointment` with `scheduled_at` between now and
+7 days, sorted by `staffId` + `scheduled_at`. In-process it
detects overlapping windows per staff member and renders a Block
Kit table with the conflicts highlighted.

**Moment 3 — the action, with approval.** The mind-blowing one.

> Send every customer with a booking tomorrow a "looking forward
> to seeing you" SMS. Wait — show me the list first so I can
> approve.

The agent:

1. Calls `list_appointment` filtered to tomorrow + `status:
   booked`.
2. Calls `render_table` with the rows (customer_name, time,
   service, phone — last 4 digits masked).
3. Replies in chat: *"Here are the 14 appointments. Reply with
   `confirm` to send the SMS to all, or list the names to skip
   for any I should leave out."*

In Slack you type:

> confirm

The agent calls the Twilio plugin's `sendSms` tool **once per
row** (or via a small batch helper if available — Claude will
choose the right pattern based on the MCP surface). For each
call, the audit plugin records a row in the `audit` collection.
The bot reports: *"Sent 13, 1 number invalid (rejected by Twilio):
Marcus K. (+1xxx-xxx-1234)."*

Audit replay:

> Show me a table of every SMS we sent in the last hour from the
> audit log.

Agent calls `list_audit` (an admin-only resource — your tenant
admin role has the `list` bypass), filters to `action: 'plugin.twilio.sendSms'`,
and renders the table. Every action the agent took is logged with
timestamp, who triggered it (you, via Slack), and the payload.

## 56:00 — Read the audit story

Open the admin UI's `audit` resource. Filter the recent rows:

- The bulk SMS produced 13 rows, all tagged with your `userId`
  and `accountId`.
- The `before`/`after` columns on appointment updates show what
  changed (e.g. `payment_status: unpaid → paid` for the Stripe
  ones).
- A field-level redaction policy (configured via
  `AUDIT_REDACT=password,token,secret`) means card details from
  the Stripe webhook never made it into the audit row.

See [Audit](/features/audit/).

## 60:00 — Done

What you have:

- A multi-tenant SaaS backend with 4 resources, automatic
  per-tenant data isolation via `accountId`, an
  appointment-confirmation Twilio integration, a 15-minute cron
  for reminders with distributed locking, and Stripe
  checkout + webhook.
- An interactive Slack bot in **per-user auth mode**, with each
  Slack user mapping to a real davepi user via a refresh-token
  link flow. The bot answers tenant-scoped queries and **takes
  bulk actions after explicit human approval**.
- A complete audit trail of every CRUD mutation and every
  agent-driven action, queryable from Slack or the admin UI.

You wrote ~120 lines of schema. You wrote zero lines of Twilio
SDK code, zero lines of Stripe webhook plumbing, zero lines of
tenant-scoping logic, zero lines of audit-write code, and zero
lines of SMS-with-approval workflow code.

## What to read next

- **[Tutorial 6: Internal IT helpdesk](/tutorials/internal-it-helpdesk/)**
  — the orthogonal demo: the agent reaches *beyond* davepi.
- [Concepts → Tenant isolation](/concepts/tenancy/) — the model
  behind the automatic scoping.
- [Surfaces → Agent → Auth modes](/surfaces/agent/) — service vs
  per-user, when to pick each, and the link-flow shape.
- [Features → Audit](/features/audit/) — what's captured, where
  it's stored, retention.
- [`davepi-plugin-twilio`](https://github.com/projik/davepi/tree/main/packages/davepi-plugin-twilio),
  [`davepi-plugin-stripe`](https://github.com/projik/davepi/tree/main/packages/davepi-plugin-stripe),
  [`davepi-plugin-cron`](https://github.com/projik/davepi/tree/main/packages/davepi-plugin-cron).
