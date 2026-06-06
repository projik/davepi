# davepi-plugin-oauth

Social login for [dAvePi][davepi] — Google, GitHub, Microsoft, Apple,
Discord. Mounts `/auth/{provider}` + `/auth/{provider}/callback`,
handles the OAuth2 / OIDC dance with state-HMAC CSRF defence and PKCE
where supported, upserts the local User, and issues the framework's
standard JWT (same shape as `/login`'s output).

[davepi]: https://docs.davepi.dev

## Install

```bash
npm install davepi-plugin-oauth
```

Add it to your project's `package.json` under `davepi.plugins`:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-oauth"]
  }
}
```

## Configure

All config is env-driven. **Per provider:** set the client id +
secret. A provider is enabled iff *both* are set; missing either
leaves the routes unmounted. **Globally required when any provider is
enabled:** `OAUTH_BASE_URL` (the publicly-reachable origin used to
build callback URLs and register with each provider) and
`OAUTH_STATE_SECRET` (HMAC key for the `state` parameter, ≥ 16 chars).

### Global

| Variable | Required | Description |
|----------|----------|-------------|
| `OAUTH_BASE_URL`         | yes if any provider enabled | Publicly-reachable origin, e.g. `https://api.example.com`. Used to build callback URLs you register with each provider. |
| `OAUTH_STATE_SECRET`     | yes if any provider enabled | HMAC key for the signed `state` param (≥ 16 random bytes recommended; 32+ ideal). |
| `OAUTH_SUCCESS_REDIRECT` | no | Where to send the browser after issuing the JWT, e.g. `https://app.example.com/auth/success?token=` — the plugin appends the access + refresh tokens. If unset, the callback returns the tokens as JSON. Ignored when `OAUTH_SUCCESS_MODE=handler`. |
| `OAUTH_SUCCESS_MODE`     | no | `redirect` (default) or `handler`. In `handler` mode the host app registers a success handler (see [Success handler](#success-handler-oauth_success_modehandler)) that takes over the login-success response — the plugin never serialises tokens into a URL. |
| `OAUTH_FAILURE_REDIRECT` | no | Where to send the browser on dance failure (provider returned error, state mismatch, etc.). If unset, the callback returns 400 JSON. |
| `OAUTH_DEFAULT_ROLES`    | no | Comma-separated default roles for newly-created users. Default `user`. Set to `admin,user` for bootstrap flows — document but don't enable by default in production. |

### Per provider

| Variable | Description |
|----------|-------------|
| `OAUTH_GOOGLE_CLIENT_ID` / `_SECRET`        | Enables `/auth/google` + callback. Default scopes: `openid email profile`. Override with `OAUTH_GOOGLE_SCOPES`. PKCE on. |
| `OAUTH_GITHUB_CLIENT_ID` / `_SECRET`        | Enables `/auth/github` + callback. Default scopes: `read:user user:email`. Override with `OAUTH_GITHUB_SCOPES`. PKCE off (GitHub doesn't support it). |
| `OAUTH_MICROSOFT_CLIENT_ID` / `_SECRET`     | Enables `/auth/microsoft` + callback. Default scopes: `openid email profile`. Override with `OAUTH_MICROSOFT_SCOPES`. PKCE on. Tenant defaults to `common`; override with `OAUTH_MICROSOFT_TENANT`. |
| `OAUTH_DISCORD_CLIENT_ID` / `_SECRET`       | Enables `/auth/discord` + callback. Default scopes: `identify email`. Override with `OAUTH_DISCORD_SCOPES`. PKCE on. |
| `OAUTH_APPLE_CLIENT_ID` / `_TEAM_ID` / `_KEY_ID` / `_KEY_PATH` *or* `_PRIVATE_KEY` | Apple needs a JWT-signed client secret. Provide team id, key id, and either a path to the `.p8` file or the PEM contents inline. |

### Provider-console setup

For each provider, in the provider's console, register an OAuth /
OIDC app with **exactly one** redirect URI per route the plugin
mounts:

- Google ([console][gc]): `{OAUTH_BASE_URL}/auth/google/callback`
- GitHub ([console][ghc]): `{OAUTH_BASE_URL}/auth/github/callback`
- Microsoft ([Entra console][msc]): `{OAUTH_BASE_URL}/auth/microsoft/callback`
- Discord ([console][dsc]): `{OAUTH_BASE_URL}/auth/discord/callback`
- Apple ([console][appc]): `{OAUTH_BASE_URL}/auth/apple/callback`

If you also use the `/link` flow, add the corresponding
`{OAUTH_BASE_URL}/auth/{provider}/link/callback` URI too.

[gc]: https://console.cloud.google.com/apis/credentials
[ghc]: https://github.com/settings/developers
[msc]: https://entra.microsoft.com
[dsc]: https://discord.com/developers/applications
[appc]: https://developer.apple.com/account/resources/identifiers/list/serviceId

### Apple-specific setup

1. Create a **Services ID** in the Apple Developer console — its
   identifier is your `OAUTH_APPLE_CLIENT_ID`.
2. Create a **Sign in with Apple** key — download the `.p8` file
   (the only chance to do so). Note the **Key ID** — that's
   `OAUTH_APPLE_KEY_ID`.
3. Your **Team ID** is in the top-right of the developer console —
   that's `OAUTH_APPLE_TEAM_ID`.
4. Either deploy the `.p8` file to disk and point `OAUTH_APPLE_KEY_PATH`
   at it, *or* paste its PEM contents into `OAUTH_APPLE_PRIVATE_KEY`
   (useful for envs that can't store secrets as files).

Apple delivers profile name fields (`firstName`, `lastName`) **only**
on the very first sign-in, via the form-post body — not via any
subsequent userinfo lookup. The plugin captures that one-shot and
persists it. Don't rely on Apple re-sending it later.

Apple may return a relay email (`...@privaterelay.appleid.com`)
instead of the user's real address. Account-linking uses the
`sub` claim (stable across sessions) as `providerUserId`, not the
email, so relay addresses don't cause duplicate users on the second
sign-in.

## What the plugin does on a successful sign-in

1. Verifies the signed `state` (HMAC-SHA256, 10-minute TTL).
2. Exchanges the `code` for tokens (with PKCE verifier where applicable).
3. Fetches the user profile.
4. Resolves the local User:
   - if `(provider, providerUserId)` is already linked → that user, update `lastLoginAt`;
   - else if a User with the returned email exists → link this provider to that user;
   - else → mint a new User with `OAUTH_DEFAULT_ROLES`.
5. Issues an access + refresh token pair via the framework's
   `utils/tokens.issueTokenPair` — identical shape to `/login`.
6. Delivers the tokens: in `handler` mode, your registered success
   handler takes over the response; otherwise the browser is
   redirected to `OAUTH_SUCCESS_REDIRECT` with the tokens in the URL,
   or — if that's unset — the callback returns them as JSON.

## Success handler (`OAUTH_SUCCESS_MODE=handler`)

Putting tokens in a redirect URL means they transit server logs,
proxies, and browser history. If your app implements a safer delivery
(e.g. a single-use handoff code), set `OAUTH_SUCCESS_MODE=handler`
and register a handler that takes over the login-success response:

```js
// in your app's own plugin / bootstrap code
const oauth = require('davepi-plugin-oauth');

oauth.registerSuccessHandler(async (req, res, { tokens, user, returnTo, provider, created }) => {
  const code = await mintSingleUseHandoffCode(tokens); // your storage
  res.redirect(302, `/auth/success#code=${encodeURIComponent(code)}`);
});
```

The handler receives `(req, res, { tokens, user, returnTo, provider,
created })` and must write the response itself; the plugin writes
nothing. `returnTo` is the validated, path-only value carried through
the state (or `null`). A thrown/rejected handler delegates to the
framework's `errorHandler` like any other callback failure.

If `handler` mode is set but no handler is registered when a callback
lands, the plugin logs an error and answers with the JSON shape —
it never falls back to a tokens-in-URL redirect.

## Account linking (already-logged-in user)

```
GET  /auth/google/link            -> 302 to Google (requires Bearer)
                                     (Accept: application/json → 200 { url })
GET  /auth/google/link/callback   -> 302 to returnTo with ?linked=google
                                     (no returnTo → 200 { linked: true, provider, providerUserId, created })
```

The link flow doesn't mint a new JWT — the caller is already
authenticated. It just persists the `oauth_identity` row so the next
time that user signs in via that provider, the existing User is
reused.

**Browser SPAs:** a top-level navigation can't attach the Bearer
header, and an authed `fetch()` can't follow the cross-origin 302 to
the provider. So when the link-start request prefers JSON (explicit
`Accept: application/json` or `X-Requested-With: XMLHttpRequest`),
the route answers `200 { url }` and the SPA navigates itself:

```js
const { url } = await api('GET', '/auth/github/link?returnTo=/dashboard');
location.href = url;
```

When the link-start carried a `returnTo` (validated path-only, same
rules as login), the link callback 302s back there with
`?linked=<provider>` appended — the user lands on a real dashboard
route, not a JSON page. Without `returnTo`, the JSON response shape
is unchanged.

If the identity is already linked to a *different* user, the plugin
rejects with the framework's `ConflictError` (409,
`code: 'oauth_identity_owned_by_other'`) — silently stealing another
tenant's identity would be a footgun. When a `returnTo` is available,
the callback instead 302s to
`{returnTo}?error=oauth_identity_owned_by_other&provider=<id>` so the
user sees a readable dashboard error rather than an error page.

## `oauth_identity` collection

Per-link record. Schema:

```js
{
  userId:         ObjectId,   // local User._id
  provider:       String,     // 'google' | 'github' | ...
  providerUserId: String,     // stable id from the provider
  email:          String,     // denormalised; refreshed on each sign-in
  profile:        Mixed,      // raw provider payload (sub, etc.)
  linkedAt:       Date,
  lastLoginAt:    Date,
}
```

Unique index on `(provider, providerUserId)`.

## Security notes

- **State is authenticated-encrypted (AES-256-GCM), not just signed.**
  The PKCE `code_verifier` travels in the state payload so the
  callback can recover it without server-side session storage; an
  HMAC-only state would leak the verifier to anyone observing the
  authorize URL, defeating PKCE's interception-mitigation purpose.
  The encryption key is derived from `OAUTH_STATE_SECRET` via
  SHA-256.
- **`returnTo` is path-only, never a destination.** When you pass
  `/auth/{provider}?returnTo=...`, the value is validated as a safe
  relative path (must start with `/`, must not be protocol-relative,
  must not contain `://`). Validated paths travel through the
  encrypted state and are appended to `OAUTH_SUCCESS_REDIRECT` as a
  `returnTo` query param the SPA can consume. The browser's redirect
  destination is **always** `OAUTH_SUCCESS_REDIRECT` — there is no
  caller-supplied way to redirect somewhere else. This is the
  open-redirect defence: an attacker can't initiate a real flow with
  `returnTo=https://evil.example/...` to exfiltrate tokens.
- **Provider error responses delegate to the framework's
  `errorHandler`.** When the provider's callback URL carries
  `?error=access_denied` (or similar) and `OAUTH_FAILURE_REDIRECT`
  is unset, the plugin calls `next(new ValidationError(...))`
  rather than `res.status(400).json(...)` so the response shape
  matches every other 4xx the framework emits.
- **The provider's access_token is not persisted by default.** The
  plugin only needs the profile to mint the framework's JWT.
- **PKCE on by default** for every provider that supports it, even
  with confidential clients (server-side secret).
- **Apple form_post callbacks are parsed by a plugin-local
  middleware.** The framework only mounts `express.json()`
  globally; the plugin adds a tiny urlencoded parser in front of
  the POST callback routes so Apple's `response_mode=form_post`
  works out of the box. A host app that already mounts
  `express.urlencoded()` globally is honoured (the parser is a
  no-op when `req.body` is already populated).
- The framework's `/api/v1/...` auth posture is unchanged: the JWT
  the plugin mints is identical to the one `/login` mints, so
  `verifyToken` accepts it without modification.

## Why "dormant" matters

A project that hasn't wired any OAuth provider yet should still
boot. The plugin logs a warning and exits `setup()` rather than
crashing — same posture as `davepi-plugin-postmark` when the server
token is unset.
