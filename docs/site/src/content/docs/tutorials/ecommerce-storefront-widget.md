---
title: 3. E-commerce storefront widget — two audiences, one backend
description: Staff in Slack and anonymous customers on a marketing site asking questions about the same catalog. Public reads via X-Client-Id, write refusal automatic, role-scoped filters on the server.
---

You run an online coffee shop. Your staff are in Slack and ask
"which products are running low on inventory?" Your customers are
on the marketing site and ask "what single-origin Ethiopian
coffees do you have under $25?" One dAvePi backend, two
audiences, two auth boundaries, zero duplicated code.

**You'll learn**: `schema.acl.scope[role]`, the `apiClient` row,
the `X-Client-Id` public-read flow, embedding the agent's HTTP
`/chat` endpoint as a widget on a static site, and dual auth
(service-account widget + per-user Slack bot — well, in this
case service-account on both sides because we want the staff bot
acting as the shop owner; we'll do per-user Slack in
[Tutorial 5](/tutorials/multi-tenant-bookings/)).

**Time budget**: ~35 minutes.

## 0:00 — Scaffold

```bash
npx create-davepi-app coffee-shop --template blank
cd coffee-shop
docker compose up -d
npm start
```

Delete `schema/versions/v1/note.js`.

## 2:00 — Three schemas

`schema/versions/v1/product.js`:

```js
module.exports = {
  path: 'product',
  collection: 'product',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'description', type: String, searchable: true },
    { name: 'price', type: Number, required: true },
    { name: 'origin', type: String, searchable: true },
    {
      name: 'roast',
      type: String,
      enum: ['light', 'medium', 'medium-dark', 'dark'],
    },
    { name: 'inventory_count', type: Number, default: 0 },
    { name: 'in_stock', type: Boolean, default: true },
    { name: 'published', type: Boolean, default: false },
  ],
};
```

`schema/versions/v1/customer.js`:

```js
module.exports = {
  path: 'customer',
  collection: 'customer',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true },
    { name: 'email', type: String, required: true },
  ],
};
```

`schema/versions/v1/order.js`:

```js
module.exports = {
  path: 'order',
  collection: 'order',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'customerId', type: String, required: true },
    { name: 'line_items', type: [{ productId: String, quantity: Number, unit_price: Number }] },
    { name: 'total', type: Number, required: true },
    {
      name: 'status',
      type: String,
      enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'],
      default: 'pending',
    },
    { name: 'placed_at', type: Date, default: Date.now },
  ],
  relations: {
    customer: { belongsTo: 'customer', localKey: 'customerId' },
  },
  aggregations: [
    {
      name: 'salesByDay',
      description: 'Total order value per day.',
      pipeline: [
        { $match: { status: { $in: ['paid', 'shipped', 'delivered'] } } },
        {
          $group: {
            _id: { y: { $year: '$placed_at' }, m: { $month: '$placed_at' }, d: { $dayOfMonth: '$placed_at' } },
            total: { $sum: '$total' },
            orders: { $sum: 1 },
          },
        },
        { $sort: { '_id.y': 1, '_id.m': 1, '_id.d': 1 } },
      ],
      cache: { ttlSeconds: 60 },
    },
  ],
};
```

Hot reload picks all three up. Register + log in (see [Tutorial
1](/tutorials/habit-tracker/) if needed). The admin UI shows three
new resources.

## 6:00 — Seed the catalog

Add ~8 coffees through the admin UI. Mix the data:

- 5 with `published: true`, `in_stock: true`, `inventory_count > 0`.
- 1 with `published: false` (an unreleased seasonal blend).
- 1 with `published: true` but `in_stock: false`.
- 1 with `published: true`, `in_stock: true`, `inventory_count: 0`
  (sold out, not yet flipped to `in_stock: false`).

Tag a few `origin: Ethiopia` and vary the price.

## 9:00 — Ask the agent for the storefront ACL rule

Open Claude Code:

> Add an `acl.scope.storefront` rule to product so that the
> `storefront` role only sees published, in-stock products with
> `inventory_count > 0`. Storefront should also be in the
> `acl.list` bypass so it can see across tenants — there's only
> one tenant in this demo, but I want to be explicit that
> storefront is a cross-tenant role.

Claude edits `schema/versions/v1/product.js` to add:

```js
acl: {
  list: ['storefront'],
  scope: {
    storefront: {
      published: true,
      in_stock: true,
      inventory_count: { $gt: 0 },
    },
  },
},
```

The framework `$and`-s this filter into every read for callers
with the `storefront` role. The caller cannot widen it — a
storefront client passing `?published=false` gets back no results.
See [ACL](/features/acl/) and [Concepts → Tenant
isolation](/concepts/tenancy/).

Also ask Claude:

> Also strip the `inventory_count` field from storefront reads
> (`acl.read: ['admin', 'user']` on that field).

Result on the field:

```js
{
  name: 'inventory_count',
  type: Number,
  default: 0,
  acl: { read: ['admin', 'user'] },
},
```

Storefront callers never see `inventory_count` in any response
shape — REST, GraphQL, or MCP.

## 13:00 — Mint a storefront client ID

`apiClient` is a built-in resource in dAvePi for issuing public
client IDs. Through the admin UI: navigate to **apiClient**,
**New**, fill in:

| Field         | Value                |
| ------------- | -------------------- |
| `_id`         | `pk_storefront_live` |
| `name`        | Storefront widget    |
| `role`        | `storefront`         |
| `status`      | `active`             |
| `description` | Public catalog       |

Save.

Client IDs are **public identifiers, not secrets** — they're meant
to be baked into SPA bundles. You rotate by setting `status` to
`revoked`. See [Public reads](/features/acl/#public-reads).

Test the boundary:

```bash
# As storefront client — sees only orderable, published items, no inventory_count
curl -s 'http://localhost:5050/api/v1/product' \
  -H 'X-Client-Id: pk_storefront_live' | jq '.results | length'

# As you (admin) — sees everything
curl -s 'http://localhost:5050/api/v1/product' \
  -H "Authorization: Bearer $TOKEN" | jq '.results | length'

# Try to widen the scope — should NOT return unpublished rows
curl -s 'http://localhost:5050/api/v1/product?filter[published]=false' \
  -H 'X-Client-Id: pk_storefront_live' | jq
```

The storefront list count is lower than your admin list count.
The widening attempt returns zero rows, not unpublished ones.

## 18:00 — Install the agent twice

We're going to run two agents on different ports:

- **Staff agent** on `:5060` — service-auth as you (admin),
  attached to Slack.
- **Storefront agent** on `:5062` — service-auth with
  `X-Client-Id`, exposed via HTTP for the widget on the marketing
  site.

```bash
npm install @davepi/agent
```

`.env.staff`:

```bash
DAVEPI_URL=http://localhost:5050
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
DAVEPI_BEARER=eyJ...            # your admin /login token
AGENT_HTTP_PORT=5060
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_SOCKET_MODE=true
SLACK_APP_TOKEN=xapp-...
```

`.env.storefront`:

```bash
DAVEPI_URL=http://localhost:5050
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
DAVEPI_CLIENT_ID=pk_storefront_live    # not a bearer — public client
AGENT_HTTP_PORT=5062
AGENT_CORS_ORIGINS=http://localhost:8000     # where you'll serve the marketing site
SLACK_ENABLED=false                     # storefront agent has no Slack
```

Why two processes? Because each agent locks in one identity at
startup. You could run one process with a fancier auth strategy,
but the two-process layout matches how you'd actually deploy:
staff agent inside the VPC, storefront agent on a public hostname
behind a CDN.

Start them in two shells:

```bash
# shell 1
set -a; source .env; source .env.staff; set +a
npx davepi-agent

# shell 2
set -a; source .env; source .env.storefront; set +a
npx davepi-agent
```

## 24:00 — Drop the widget on a marketing site

Create `marketing/index.html` with a minimal vega-embed-capable
chat widget pointed at the storefront agent:

```html
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>Coffee Shop</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
  #log { border: 1px solid #ccc; padding: 1rem; min-height: 240px; white-space: pre-wrap; }
  form { display: flex; gap: 0.5rem; margin-top: 1rem; }
  input { flex: 1; padding: 0.5rem; font-size: 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; }
  table { border-collapse: collapse; margin: 0.5rem 0; }
  th, td { border: 1px solid #ddd; padding: 4px 8px; }
</style>
</head><body>
<h1>Coffee catalog</h1>
<div id="log"></div>
<form id="f">
  <input id="msg" placeholder="ask about our coffees" autofocus />
  <button>Send</button>
</form>
<script>
  const history = [];
  const log = document.getElementById('log');
  async function send(message) {
    const turn = document.createElement('div');
    turn.textContent = '\n> ' + message + '\n';
    log.appendChild(turn);
    const reply = document.createElement('div');
    log.appendChild(reply);
    let assembled = '';
    const res = await fetch('http://localhost:5062/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, history, stream: true }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split('\n\n'); buf = blocks.pop();
      for (const block of blocks) {
        const evType = (block.match(/^event: (.+)$/m) || [])[1];
        const data = JSON.parse((block.match(/^data: (.+)$/m) || ['','{}'])[1]);
        if (evType === 'token') { reply.append(data.text); assembled += data.text; }
        else if (evType === 'render' && data.payload.type === 'table') {
          const t = document.createElement('table');
          const head = t.createTHead().insertRow();
          for (const c of data.payload.columns) { const th = document.createElement('th'); th.textContent = c.label; head.appendChild(th); }
          const body = t.createTBody();
          for (const row of data.payload.rows) {
            const tr = body.insertRow();
            for (const c of data.payload.columns) {
              const td = tr.insertCell();
              td.textContent = row[c.key] == null ? '' : String(row[c.key]);
            }
          }
          reply.appendChild(t);
        } else if (evType === 'final') {
          history.push({ role: 'user', content: message });
          history.push({ role: 'assistant', content: assembled });
        }
      }
    }
  }
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault();
    const v = document.getElementById('msg').value.trim();
    if (!v) return; document.getElementById('msg').value = '';
    send(v);
  };
</script>
</body></html>
```

Serve it from a static server on `:8000`:

```bash
cd marketing
npx http-server -p 8000
```

Open <http://localhost:8000>. Ask:

> What single-origin Ethiopian coffees do you have under $25?

The agent calls `list_product` (which on the davepi side becomes a
Mongo query `$and`-ed with the `storefront` scope filter), gets
back only published + in-stock + non-zero-inventory rows, then
calls `render_table`. The widget renders an HTML table.

Try to escape the scope:

> Show me everything you have including unreleased products.

The agent has no way to widen the filter — the davepi server
applies the `acl.scope.storefront` predicate to every read.
Whatever query the agent constructs, only public-eligible rows
come back. The agent will either say "I can only show our
current catalogue" or simply not see the hidden rows. Either way,
the **JWT/client-id is the access boundary, not the prompt**.
See [Concepts → Agent-first](/concepts/agent-first/).

## 30:00 — Now the staff bot

In Slack, DM your `support-inbox-bot` (or rename to
`coffee-staff-bot`). Try:

> Which products are running low on inventory?

The agent — authed as you, admin role — sees all products
including `inventory_count`. It filters to low-stock and renders a
Block Kit table.

> Chart sales for the last 30 days.

Agent reaches for `aggregate_order_salesByDay`, gets daily totals,
calls `render_chart` with a Vega-Lite line spec. The Slack channel
serialises that to a QuickChart image URL.

> What's the catalog look like for our public site visitors
> versus what I see internally?

The agent doesn't have two identities at once — it'll say
something like "as the admin agent I see X products total; on the
storefront widget customers see Y." That's the right answer; if
you want it to query both, you'd run two separate agents (which
you are) and the agent can describe the difference but not
literally call the storefront agent.

## 34:00 — Done

What you have:

- A 3-collection backend with a real ACL story — field-level read
  restrictions and document-level scope filters.
- An `apiClient` row issuing public read access to a
  `storefront` role with a server-imposed mandatory filter.
- Two agent processes — staff agent on Slack as admin,
  storefront agent on HTTP as anonymous client — sharing one
  backend.
- A static-HTML widget on `:8000` that talks to the public agent.

The **dual auth + role-scoped filter** combination is the key
shape. From here you can stand up a customer-service widget on
any static site by pointing it at the storefront agent's `/chat`
endpoint. Operators rotate access by flipping the `apiClient`
row's `status` to `revoked` — no code redeploy.

## What to read next

- **[Tutorial 4: Real estate leads](/tutorials/real-estate-leads/)**
  — adds plugins and the event bus; the system reacts on its own.
- [Features → ACL](/features/acl/) — the full surface of field
  and document ACL.
- [Surfaces → Agent → Embeddable widget](/surfaces/agent/)
  — fuller widget recipe with auth + branding.
- [Features → Plugins](/features/plugins/) — what plugins are and
  how they compose.
