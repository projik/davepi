---
title: Auth modes
description: Two ways to wire a davepi agent to a backend — one bearer for everyone (service) or one refresh token per channel user (per-user). How to choose, how to deploy, and how the link flow protects refresh tokens from URL leakage.
---

The JWT (or `X-Client-Id` header) **is** the access boundary on
every read and write. The agent picks one of two strategies for
deciding *whose* token to send:

| Mode       | One identity for the whole bot?                 | Each channel user maps to a real davepi user?     |
| ---------- | ----------------------------------------------- | ------------------------------------------------- |
| `service`  | Yes — `DAVEPI_BEARER` or `DAVEPI_CLIENT_ID`     | No                                                |
| `per-user` | No                                              | Yes — via a one-time link flow                    |

Pick `service` for anonymous-public surfaces (a storefront widget)
and shared-service-account bots. Pick `per-user` when each user
must see their own data only and you'd rather lean on davepi's
existing owner-scoping than reinvent a row-level filter.

`AGENT_AUTH_MODE` switches between them (default `service`).

## Service mode

One identity. Every chat turn, every tool call, every MCP request
uses the same token. Easiest to deploy: no per-user state, no
refresh-token store, no link UI.

### Bearer (JWT)

```bash
AGENT_AUTH_MODE=service          # the default
DAVEPI_BEARER=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

The bearer is treated as **static** — the agent doesn't rotate via
refresh tokens in this mode. davepi's `/login` issues access
tokens with `ACCESS_TOKEN_TTL` (default `15m`), so for a local
demo you'll want `ACCESS_TOKEN_TTL=2h` in your davepi server's
`.env` (`2h` is the policy ceiling for access tokens — don't go
higher; production deployments rotate via per-user mode below).
Production options:

1. **Per-user mode** (below) — the agent rotates refresh tokens
   automatically. **Recommended for production** because access
   tokens stay short-lived (≤2h) without operator intervention.
2. **Client id** (below) for anonymous reads.

The user behind the bearer is the **tenant owner** for the agent's
data. Memory, persona, skills, and conversations all stamp `userId`
from that JWT, so the agent reads and writes its own
tenant-isolated rows.

### Client id

```bash
AGENT_AUTH_MODE=service
DAVEPI_CLIENT_ID=pk_storefront_live_abc123
```

The client id is a **public identifier** (bake it into the SPA
bundle); the apiClient row on the davepi side declares the role,
and any `schema.acl.scope[role]` filters server-side restrict
visibility. The agent has no JWT — writes are refused server-side.

[→ Tenant isolation](/concepts/tenancy/)

When both `DAVEPI_BEARER` and `DAVEPI_CLIENT_ID` are configured,
bearer wins. Mirrors `middleware/clientAuth.js`.

### When to use service mode

- Anonymous storefront / marketing-site widget.
- An internal "shared inbox" bot where every operator sees the same
  data.
- Single-tenant deployments where the whole bot acts as the tenant's
  shared service account.

### The `agent` service role

When the [learning layer](/agents/personas-memory-skills/) is on,
your agent's user should hold role `['agent']` (not just `user` or
`admin`). Field-level ACL on `agentPersona` and `skill.status` is
keyed off the `agent` role — without it, the agent could rewrite
its own brand voice or self-approve skills.

The deployment contract:

| Caller                        | Roles            | Surfaces                                |
| ----------------------------- | ---------------- | --------------------------------------- |
| Agent process (service token) | `['agent']`      | Can read all tenant data, write memory and customer profiles, draft skills, propose persona patches. Cannot promote skills or rewrite persona. |
| Human operator (login JWT)    | `['user']` / `['admin']` | Can read everything and author persona, approve skills, etc. |

## Per-user mode

Each channel user maps to a real davepi user via a refresh token
stored locally. Access tokens are minted on demand and cached just
under the access-token TTL (`AGENT_ACCESS_TTL_SECONDS`, default
`900` / 15 min, refreshed `AGENT_REFRESH_SKEW_SECONDS` early
to absorb clock skew).

```bash
AGENT_AUTH_MODE=per-user
AGENT_LINK_BASE_URL=https://agent.example.com      # public URL of the agent itself
AGENT_SESSION_SECRET=$(openssl rand -hex 32)        # HMAC key for the session cookie
STORE_URL=file:./davepi-agent-store.json            # refresh-token persistence
```

### The link flow

davepi does **not** ship a browser-redirect OAuth `/login` — only
JSON POST `/login` and POST `/auth/refresh`. The agent hosts the
link UI itself, server-to-server to davepi, so the refresh token
never crosses the browser:

```
┌─────────┐   1. /chat (unlinked)         ┌──────────┐
│ user    │  ────────────────────────────▶│ agent    │
│         │                               │          │
│         │   2. UnlinkedError: /link/<n> │          │
│         │  ◀────────────────────────────│          │
│         │                               │          │
│         │   3. GET /link/<nonce>        │          │
│         │  ────────────────────────────▶│  serves  │
│         │       (HTML form)             │  HTML    │
│         │  ◀────────────────────────────│          │
│         │                               │          │
│         │   4. POST email + password    │          │      5. POST /login    ┌──────────┐
│         │  ────────────────────────────▶│  agent   │  ──────────────────▶  │ davepi   │
│         │                               │          │  ◀──── refreshToken   │          │
│         │   6. session cookie + 'linked'│          │       (server-side)   └──────────┘
│         │  ◀────────────────────────────│          │
│         │                               │          │
│         │   7. /chat (now linked)       │          │
│         │  ────────────────────────────▶│          │
└─────────┘                               └──────────┘
```

The refresh token is stored in the agent's `STORE_URL`, keyed by
`(channel, channelUserId)`. On every chat turn the agent looks up
the row, mints a fresh access token if needed, and uses it as the
bearer for MCP calls.

### The session cookie (HTTP channel)

For HTTP-channel users, `POST /link/<nonce>` succeeding sets an
HMAC-signed `davepi_agent_session` cookie:

- `HttpOnly` — not JS-accessible.
- `SameSite=Lax` — survives top-level navigation, blocked cross-site.
- `Secure` when `AGENT_COOKIE_SECURE=true` (default).
- HMAC-signed with `AGENT_SESSION_SECRET`. The cookie body carries
  `{ cuid, iat, exp }` (channel user id, issued-at, expires-at).
- 30-day lifetime.

`POST /chat` reads the cookie on every request and **ignores any
body-supplied `channelUserId`**. The earlier draft trusted
body-supplied IDs, which let any caller act as any linked user
(flagged in PR #128 review #8); the cookie is now the trust
boundary.

Other channels (Slack, Telegram, WhatsApp) have their own platform
identity — the platform's signed event payload is the trust
anchor — so they don't need the browser cookie.

### Why not refresh tokens in URL query?

The original draft accepted refresh tokens at
`POST /oauth/callback?refreshToken=...`. That endpoint now exists
only to **refuse loudly**, because URL-borne tokens leak via:

- Server access logs.
- Browser history.
- `Referer` headers when the user clicks an outbound link.
- Tab-share / screenshot scenarios.

The form-based flow keeps the refresh token strictly server-side.
Legacy clients that hit `/oauth/callback` get a 403 with a clear
*"use /link/<nonce> instead"* message.

### Store URLs

| `STORE_URL`                       | Behaviour                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `file:./davepi-agent-store.json`  | JSON file on disk. Survives restarts. Default.                                             |
| `memory:`                         | In-process only. Loses every refresh token on restart. Right for tests and stateless dev.  |

For multi-instance per-user deployments you'll want a shared store
— roadmap: a Redis-backed store. Today the file-store is
single-process; running two replicas with the same store path is
unsupported.

### When to use per-user mode

- A customer-portal bot where each customer must see only their own
  orders/invoices/tickets.
- An internal bot where the audit trail must record *which person*
  triggered each write.
- Any deployment where davepi's owner-scoping is already the
  authorisation model you want.

## Choosing between them

| If you can say…                                                                  | Use…       |
| -------------------------------------------------------------------------------- | ---------- |
| *"Every visitor sees the same role-scoped slice of public data."*                | `service`  |
| *"There's one shared inbox; everyone on our team should see the same conversations."* | `service`  |
| *"Customer A must not see customer B's data, ever."*                             | `per-user` |
| *"The audit log must record which human triggered each write."*                  | `per-user` |
| *"I want owner-scoping for free without writing a tenant filter."*               | `per-user` |

A common pattern: **service mode for the storefront widget**
(anonymous-read of published products), **per-user mode for the
support bot** (each customer sees their own tickets). They can run
as two separate processes against the same davepi backend.

## Multi-tenant deployments

Each davepi tenant is a separate `userId` (and stamped `accountId`)
on the server side. Two options for hosting multiple tenants'
agents:

### One process per tenant

Simplest. Each tenant gets its own agent process with its own
`DAVEPI_BEARER` (or `AGENT_LINK_BASE_URL` per-user) and `AGENT_KEY`.
Process-level isolation matches the data-level isolation. Scale by
running more processes; reach by per-tenant subdomain or path-based
routing in front.

### One process, dispatcher pattern

Use `createAgent({ ... })` to mint per-tenant instances from a
shared codepath. The dispatcher reads the inbound request, decides
which tenant's auth to use, and routes to that agent. Right when
you have many small tenants and the per-process overhead would
dominate. See [Programmatic API](/agents/programmatic-api/).

In both cases the **server-side tenancy invariant is the floor** —
the agent can't read another tenant's data even if you misconfigure
it, because davepi's owner-scoping is enforced server-side.

[→ Tenant isolation](/concepts/tenancy/)

## Logging out / unlinking (per-user)

Today: there's no first-class `unlink` route. To force re-linking,
delete the row from `STORE_URL` matching `(channel, channelUserId)`.
The next chat turn from that user throws `UnlinkedError` and the
flow restarts. Roadmap: a dedicated POST endpoint.

## Auth-related errors

| Symptom                                                          | Likely cause                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `401 UNAUTHENTICATED` on first chat in service mode              | `DAVEPI_BEARER` expired. Mint a fresh token, raise `ACCESS_TOKEN_TTL` on the davepi server (up to the 2h policy ceiling), or switch to per-user mode for automatic rotation. |
| `401 UNLINKED` with a link URL on first chat in per-user mode    | Expected — open the URL and sign in. The link is one-shot.                         |
| `403 FORBIDDEN` writing memory / customer profile                | Token's user lacks role `agent`. Check the user the agent's bearer was issued for. |
| `404 link` on opening a link URL                                 | Nonce expired (default 15 min) or already consumed. Trigger a new chat to issue a fresh one. |
| `403` posting to `/oauth/callback`                               | Expected — this endpoint refuses loudly. Use the `/link/:nonce` flow.             |

[→ Troubleshooting](/agents/troubleshooting/)
