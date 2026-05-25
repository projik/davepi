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
| `OAUTH_SUCCESS_REDIRECT` | no | Where to send the browser after issuing the JWT, e.g. `https://app.example.com/auth/success?token=` — the plugin appends the access + refresh tokens. If unset, the callback returns the tokens as JSON. |
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
6. Either redirects the browser to `OAUTH_SUCCESS_REDIRECT` with the
   tokens in the URL, or returns them as JSON if the env var is unset.

## Account linking (already-logged-in user)

```
GET  /auth/google/link            -> 302 to Google (requires Bearer)
GET  /auth/google/link/callback   -> 200 { linked: true, provider, providerUserId, created }
```

The link flow doesn't mint a new JWT — the caller is already
authenticated. It just persists the `oauth_identity` row so the next
time that user signs in via that provider, the existing User is
reused.

If the identity is already linked to a *different* user, the plugin
throws `409`-style — silently stealing another tenant's identity
would be a footgun.

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

- The provider's access_token is **not** persisted by default. The
  plugin only needs the profile to mint the framework's JWT.
- `OAUTH_SUCCESS_REDIRECT` is read from env, not from a query
  parameter, so it can't be used as an open redirect. To support
  caller-supplied post-login URLs, carry them via the signed
  `state.returnTo` (the plugin does this for you when you pass
  `?returnTo=...` to `/auth/{provider}`).
- PKCE is on by default for every provider that supports it, even
  with confidential clients (server-side secret).
- The framework's `/api/v1/...` auth posture is unchanged: the JWT
  the plugin mints is identical to the one `/login` mints, so
  `verifyToken` accepts it without modification.

## Why "dormant" matters

A project that hasn't wired any OAuth provider yet should still
boot. The plugin logs a warning and exits `setup()` rather than
crashing — same posture as `davepi-plugin-postmark` when the server
token is unset.
