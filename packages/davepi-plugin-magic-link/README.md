# davepi-plugin-magic-link

Passwordless **email magic-link login** for [dAvePi](https://docs.davepi.dev).

The framework ships JWT + bcrypt password users (`/register`, `/login`) but no
magic links. This plugin adds them, reusing davepi's own primitives: it mints a
real davepi session via `utils/tokens.issueTokenPair` — so the rest of the API
accepts the token unchanged — and emails the link via `utils/mailer` (which
logs instead of sending outside production, so the dev link is always visible
in your console).

## Install

```bash
npm install davepi-plugin-magic-link
```

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-magic-link"]
  }
}
```

The plugin stays **dormant** until `MAGIC_LINK_URL` is set, so it's safe to
declare before the frontend is wired.

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `MAGIC_LINK_URL` | — (required) | Frontend URL the emailed link points at, e.g. `https://app.example.com/auth/verify`. The token is appended as `?token=...` / `&token=...` (or concatenated when the URL ends in `=`). |
| `MAGIC_LINK_PATH` | `/auth/magic-link` | Base path the routes mount under. |
| `MAGIC_LINK_TTL_MINUTES` | `30` | Link lifetime, clamped to 1–1440. |
| `MAGIC_LINK_ALLOW_SIGNUP` | `true` | When `false`, unknown emails still get a `204` (no enumeration) but no account is created and no mail is sent. |
| `MAGIC_LINK_DEFAULT_ROLES` | `user` | Comma/space-separated roles stamped onto users the plugin creates. |
| `APP_NAME` | loader-provided | Used in email subjects/bodies. |

Email delivery uses the framework mailer, so the usual `SMTP_*` env vars
apply in production.

## Routes

### `POST /auth/magic-link/request` — `{ email, name? }`

Always responds `204`. The response never reveals whether the email already
has an account. New emails get a user with an unguessable random password
(sign-in is by link only) unless `MAGIC_LINK_ALLOW_SIGNUP=false`. Rate-limited
with the framework's `authLimiter`.

### `POST /auth/magic-link/verify` — `{ token }`

Atomically claims the single-use token (concurrent verifies can't both win),
checks expiry at read time, and responds with the framework's standard
`{ accessToken, refreshToken }` pair plus:

```json
{
  "user": { "_id": "...", "email": "...", "roles": ["user"] },
  "purpose": "login",
  "meta": null
}
```

### `POST /auth/magic-link/invite` — `{ email, name?, note?, meta? }` (authenticated)

A generic invite flow: arbitrary `meta` rides on the token and is returned at
verify, so an app can carry its own context (a household id, a team id, a
seat) through the link without the plugin knowing about it.

Because `meta` is caller-supplied, it is **refused with `403` unless the host
app registers an authoriser** — the safe default against confused-deputy
injection (a caller smuggling ids they don't own into another user's session):

```js
const magicLink = require('davepi-plugin-magic-link');

magicLink.registerInviteAuthoriser(async (req, { email, meta }) => {
  // Throw to refuse. Verify everything in `meta` belongs to the caller.
  const household = await mongoose
    .model('household')
    .findOne({ _id: meta.householdId, userId: req.user.user_id })
    .lean();
  if (!household) throw new ForbiddenError('household not found for this account');

  // Optional: bind the link to a specific account. Returning the
  // inviter's own userId implements a shared-account model — the
  // invitee logs into the SAME user as the inviter, and your app
  // reads `meta` from the verify response to know who they are.
  return { userId: req.user.user_id };
});
```

Without a return value (or returning nothing), the invitee gets their own
find-or-create account.

## Programmatic use

`issueMagicLink({ email, userId, purpose, meta })` mints a token row and
returns the raw token, for custom flows (e.g. sending the link through a
different channel):

```js
const raw = await magicLink.issueMagicLink({
  email: 'a@b.co',
  userId: user._id,
  purpose: 'invite',
  meta: { campaign: 'beta' },
});
```

## Security posture

- Only the **SHA-256 hash** of the emailed token is stored — never the token
  itself — in a TTL-indexed `magic_link_token` collection (the TTL index is a
  janitor; the verify query enforces expiry at read time).
- Tokens are **single-use**: the claim is an atomic `findOneAndUpdate`, so a
  replay or a concurrent verify loses.
- The request route is **enumeration-safe**: `204` for known and unknown
  emails alike, including when signup is disabled.
- New accounts get a random bcrypt-hashed password the user never learns.

## Tests

```bash
npm test
```

The suite runs standalone (`node --test`) with injected stubs — no `davepi`,
`mongoose`, or `bcryptjs` install required.
