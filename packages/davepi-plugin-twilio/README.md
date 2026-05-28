# davepi-plugin-twilio

Twilio integration for [dAvePi][davepi]: outbound SMS and WhatsApp,
passwordless OTP-over-SMS login, TOTP-based 2FA enrollment / verify /
challenge, and an inbound SMS webhook with signature verification.
**Dormant when `TWILIO_ACCOUNT_SID` is unset** so the plugin can ship
in a project before Twilio is wired.

[davepi]: https://docs.davepi.dev

## Install

```bash
npm install davepi-plugin-twilio
```

Add it to your project's `package.json` under `davepi.plugins`:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-twilio"]
  }
}
```

## Configure

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TWILIO_ACCOUNT_SID`           | yes (otherwise dormant) | — | Twilio account SID. Found in the Twilio console. |
| `TWILIO_AUTH_TOKEN`            | yes | — | Twilio auth token. Also used to validate inbound webhook signatures. |
| `TWILIO_FROM_NUMBER`           | yes for SMS (unless using a messaging service) | — | Sender number in E.164 format. |
| `TWILIO_MESSAGING_SERVICE_SID` | no | — | Twilio Messaging Service SID. When set, takes precedence over `TWILIO_FROM_NUMBER`. |
| `TWILIO_WHATSAPP_FROM`         | yes for WhatsApp | — | WhatsApp sender, e.g. `whatsapp:+14155238886`. |
| `TWILIO_INBOUND_PATH`          | no | (off) | Mount path for the inbound SMS webhook. Leave unset to disable. |
| `OTP_PATH`                     | no | `/auth/otp` | Mount path for OTP send + verify routes. Empty string disables. |
| `OTP_DIGITS`                   | no | `6` | Number of digits in the OTP code. |
| `OTP_TTL_SECONDS`              | no | `600` | OTP validity window. |
| `OTP_MAX_ATTEMPTS_PER_HOUR`    | no | `5` | Per-phone send rate limit (rolling 1-hour window). |
| `TWILIO_APP_NAME`              | no | `APP_NAME`, then `"dAvePi"` | Used as the prefix in the SMS body and as the TOTP issuer label. |
| `TOKEN_KEY`                    | yes for 2FA | — | Symmetric secret used to encrypt TOTP secrets at rest (AES-256-GCM, key derived via SHA-256). The framework's JWT-signing key — already required by dAvePi. |

A missing `TWILIO_ACCOUNT_SID` is intentional: the plugin logs a
warning and stays dormant. Calls to `sendSms` / `sendWhatsApp` throw
in that state, and the OTP / 2FA / inbound routes are not mounted.

## Sending SMS or WhatsApp from a hook

```js
const twilio = require('davepi-plugin-twilio');

module.exports = {
  path: 'order',
  collection: 'order',
  fields: [/* ... */],
  hooks: {
    afterCreate: async ({ record, req }) => {
      try {
        await twilio.sendSms({
          to: record.customerPhone,
          body: `Order ${record.code} received. Thanks!`,
        });
      } catch (err) {
        (req?.log || console).error({ err }, 'afterCreate SMS failed');
      }
    },
  },
};
```

WhatsApp is the same surface; for content-template sends, pass a
`templateSid` and a `variables` object:

```js
await twilio.sendWhatsApp({
  to: '+15555550100',                              // whatsapp: prefix is added if absent
  templateSid: 'HXabcdef...',                      // Twilio Content SID
  variables: { 1: 'Alice', 2: 'ORD-42' },
});
```

## OTP-over-SMS passwordless login

When `OTP_PATH` is set (default `/auth/otp`), the plugin mounts two
routes:

```
POST /auth/otp         { phone }             → { ok: true, expiresInSeconds }
POST /auth/otp/verify  { phone, code }       → { accessToken, refreshToken, user }
```

- `phone` is normalised to E.164 via `libphonenumber-js`.
- The code is cryptographically random, hashed (sha256) before
  storage in the `otp_challenge` collection, and TTL-indexed so Mongo
  drops it automatically.
- Per-phone rate limiting tracks a rolling 1-hour window in the
  `otp_rate` collection. Exhausting `OTP_MAX_ATTEMPTS_PER_HOUR`
  returns 403 `FORBIDDEN`.
- Verify uses constant-time comparison and a 5-attempts-and-out
  counter; the row is deleted on exhaustion.
- On a successful verify the plugin upserts a User row by `phone`
  (Mongoose `strict: false` — the consumer's User model evolution is
  theirs to own) and issues a JWT via the framework's
  `utils/tokens.issueTokenPair`. Same access / refresh token shape as
  every other dAvePi login.

## TOTP 2FA

Three authenticated / one anonymous route:

```
POST /auth/2fa/enroll      (Bearer JWT) → { otpauthUrl, secret, backupCodes }
POST /auth/2fa/verify      (Bearer JWT) { code } → { ok: true }
POST /auth/2fa/challenge   { userId|phone, code } → { accessToken, refreshToken, user }
```

- `enroll` generates a TOTP secret via `otplib`, encrypts it with
  AES-256-GCM keyed off `TOKEN_KEY`, and returns the `otpauth://`
  provisioning URL (render as a QR), the raw secret (for manual
  entry), and eight 12-char base32 backup codes. **The backup codes
  are returned once** and stored only as sha256 hashes — show them
  to the user, then forget them.
- `verify` decrypts the pending secret, calls
  `authenticator.verify({ token, secret })`, and on success flips
  `twofaEnabled: true` and promotes the pending secret to the live
  one.
- `challenge` accepts either a fresh TOTP code or one of the backup
  codes; a used backup code is removed from the hash list on success.

**Login integration.** The framework's `/login` route lives in the
host app, not in this plugin — we intentionally don't monkey-patch
it. Your `/login` handler (or a future framework hook) decides what
to do when `user.twofaEnabled === true`: typically, return a
`twofaRequired: true` flag with a one-shot challenge token instead of
a JWT, then have the SPA call `/auth/2fa/challenge` with the user's
TOTP. The plugin also exports
`verifyTotpForUser(userId, code)` for in-process callers (a custom
`/login` route, a `beforeLogin` hook) that prefer not to round-trip
through HTTP.

## Inbound SMS webhook

Set `TWILIO_INBOUND_PATH` to the path you configured in the Twilio
console (e.g. `/webhooks/twilio/inbound`) and the plugin mounts a
handler that:

1. Validates `X-Twilio-Signature` against `TWILIO_AUTH_TOKEN`. The
   "full URL" is reconstructed from `req.protocol` (honouring
   `x-forwarded-proto`), `req.get('host')` (honouring
   `x-forwarded-host`), and `req.originalUrl` — set
   `TRUST_PROXY=true` in dAvePi if you're behind a reverse proxy so
   these forwarded headers are believed.
2. On mismatch, delegates to the framework's central `errorHandler`
   via `next(new UnauthorizedError(...))` so the response shape
   matches every other 4xx.
3. On success, ACKs with TwiML empty `<Response/>` (Twilio expects
   `text/xml`), then fans out via `setImmediate` to handlers
   registered with `plugin.onInboundSms(handler)`. Handler errors are
   logged but never propagate back to Twilio — Twilio retries are
   for transport failures, not application failures.

The handler is mounted with an `application/x-www-form-urlencoded`
parser specifically for that route (the framework's main app uses
`express.json()` globally), so `req.body` carries the parsed
TwilioRequest fields (`MessageSid`, `From`, `To`, `Body`,
`NumMedia`, `MediaUrlN`, etc.).

```js
const twilio = require('davepi-plugin-twilio');
twilio.onInboundSms(async (msg) => {
  // route msg.Body to a ticket, log it, etc.
});
```

## Why one plugin

A consumer wiring Twilio for receipt SMS already has the Twilio
account, the auth-token secret, and the failure-isolation posture
sorted; splitting "transactional SMS" and "Twilio auth" into two
packages would duplicate config and obscure the fact that an outage
on the same Twilio account propagates to every surface together.

## License

ISC.
