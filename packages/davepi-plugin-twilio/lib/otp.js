'use strict';

/**
 * OTP-over-SMS route handlers. Two routes:
 *
 *   POST /auth/otp           → generate a code, hash + store, send SMS
 *   POST /auth/otp/verify    → constant-time check, mint a JWT
 *
 * Storage:
 *   - otp_challenge: { phone, codeHash, attempts, expiresAt (TTL) }
 *   - otp_rate:      { phone, count, windowStart, expiresAt (TTL = +1h) }
 *
 * Rate limit policy: at most OTP_MAX_ATTEMPTS_PER_HOUR sends per phone
 * in a rolling 1-hour window. Exhausting the window returns 403
 * (ForbiddenError) — the framework's `utils/errors` doesn't yet ship
 * a TooManyRequestsError type, and a 403 with a clear message is a
 * tolerable fallback for now.
 *
 * Verify policy: stored row tracks an attempt counter; after 5 failed
 * verifies the row is deleted and the caller has to start over. The
 * sha256-comparison uses `crypto.timingSafeEqual` to avoid leaking the
 * code one byte at a time.
 *
 * On a successful verify: upsert a User by `phone` (Mongoose `strict:
 * false` is intentional — the consumer's User model evolution is
 * theirs to own, and `phone` may not be declared) and issue a JWT via
 * the framework's `issueTokenPair`.
 */

const crypto = require('crypto');

const { normalisePhone } = require('./phone');

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function generateCode(digits) {
  const n = Math.max(4, Math.min(12, Number(digits) || 6));
  // Cryptographically random N digits, padded so a leading zero
  // doesn't shorten the code (which would leak length info).
  const max = 10 ** n;
  const buf = crypto.randomBytes(8);
  // BigInt to avoid Number precision loss for n > 9.
  const r = buf.readBigUInt64BE() % BigInt(max);
  return r.toString(10).padStart(n, '0');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeHexEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function buildOtpHandlers({ config, state, sendSms }) {
  function need(key) {
    const v = state[key] || (state.errors && state.errors[key]);
    return v;
  }

  function ValidationError(msg) {
    const E = state.errors && state.errors.ValidationError;
    return E ? new E(msg) : Object.assign(new Error(msg), { status: 400, code: 'VALIDATION' });
  }
  function UnauthorizedError(msg) {
    const E = state.errors && state.errors.UnauthorizedError;
    return E ? new E(msg) : Object.assign(new Error(msg), { status: 401, code: 'UNAUTHORIZED' });
  }
  function ForbiddenError(msg) {
    const E = state.errors && state.errors.ForbiddenError;
    return E ? new E(msg) : Object.assign(new Error(msg), { status: 403, code: 'FORBIDDEN' });
  }
  // SMS-dispatch / Twilio transport failures surface as 503 via the
  // framework's AppError so errorHandler renders the canonical
  // `{ error: { code, message } }` shape. Raw `new Error(...)` would
  // be caught by errorHandler too, but only as an opaque 500.
  function ServiceUnavailable(msg, cause) {
    const A = state.errors && state.errors.AppError;
    const e = A ? new A(msg, 503, 'SMS_UNAVAILABLE')
                : Object.assign(new Error(msg), { status: 503, code: 'SMS_UNAVAILABLE' });
    if (cause) e.cause = cause;
    return e;
  }

  async function rateLimit(phone) {
    if (!state.OtpRate) return; // misconfig; surface later
    const now = new Date();
    const oneHour = 60 * 60 * 1000;
    const windowEnd = new Date(now.getTime() + oneHour);
    // Single atomic upsert via aggregation pipeline. The previous
    // check-then-upsert split had a race: two concurrent callers could
    // both miss the live-window $inc, then both run the $set upsert,
    // with the second clobbering the first's count back to 1. The
    // pipeline form lets Mongo branch server-side: if the row is
    // missing or expired, reset to count=1 with a fresh window;
    // otherwise increment. With { upsert: true } on the unique
    // `phone` index, concurrent updates serialize on the same doc.
    const doc = await state.OtpRate.findOneAndUpdate(
      { phone },
      [{
        $set: {
          phone: phone,
          windowStart: {
            $cond: [
              { $or: [{ $eq: [{ $ifNull: ['$expiresAt', null] }, null] }, { $lte: ['$expiresAt', now] }] },
              now,
              { $ifNull: ['$windowStart', now] },
            ],
          },
          expiresAt: {
            $cond: [
              { $or: [{ $eq: [{ $ifNull: ['$expiresAt', null] }, null] }, { $lte: ['$expiresAt', now] }] },
              windowEnd,
              '$expiresAt',
            ],
          },
          count: {
            $cond: [
              { $or: [{ $eq: [{ $ifNull: ['$expiresAt', null] }, null] }, { $lte: ['$expiresAt', now] }] },
              1,
              { $add: [{ $ifNull: ['$count', 0] }, 1] },
            ],
          },
        },
      }],
      { upsert: true, new: true }
    );
    if (doc && doc.count > config.otpMaxPerHour) {
      throw ForbiddenError('OTP send rate limit exceeded; try again later');
    }
  }

  // Best-effort decrement on the live rate-limit window. Used to
  // refund the count when an SMS send fails so a Twilio outage
  // doesn't lock a user out for the next hour. Never throws — a
  // missing row, an expired window, or a concurrent reset all
  // resolve to "nothing to refund".
  async function refundRate(phone) {
    if (!state.OtpRate) return;
    try {
      await state.OtpRate.findOneAndUpdate(
        { phone, expiresAt: { $gt: new Date() }, count: { $gt: 0 } },
        { $inc: { count: -1 } }
      );
    } catch (_) { /* swallow */ }
  }

  const send = asyncRoute(async (req, res) => {
    const phoneRaw = req.body && req.body.phone;
    const phone = normalisePhone(phoneRaw);
    if (!phone) throw ValidationError('phone is required and must be in E.164 format');

    await rateLimit(phone);

    const code = generateCode(config.otpDigits);
    const codeHash = sha256(code);
    const ttlMs = config.otpTtlSeconds * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);

    if (!state.OtpChallenge) throw ForbiddenError('OTP storage is not configured');
    await state.OtpChallenge.findOneAndUpdate(
      { phone },
      { $set: { phone, codeHash, expiresAt, attempts: 0 } },
      { upsert: true, new: true }
    );

    try {
      await sendSms({ to: phone, body: `${state.appName} code: ${code}` });
    } catch (err) {
      // SMS failed but we already wrote the challenge row and charged
      // the rate-limit window. Roll both back best-effort so a
      // transient Twilio outage doesn't (a) leave a phantom challenge
      // the user never received and (b) consume rate-limit budget
      // that would block legitimate retries. Both ops are
      // best-effort: a follow-up storage failure is logged through
      // the eventual error but we still throw the original 503.
      try { await state.OtpChallenge.deleteOne({ phone }); } catch (_) {}
      await refundRate(phone);
      throw ServiceUnavailable('SMS dispatch failed', err);
    }

    res.status(200).json({ ok: true, expiresInSeconds: config.otpTtlSeconds });
  });

  const verify = asyncRoute(async (req, res) => {
    const phoneRaw = req.body && req.body.phone;
    const code = req.body && req.body.code;
    const phone = normalisePhone(phoneRaw);
    if (!phone || !code) throw ValidationError('phone and code are required');

    if (!state.OtpChallenge) throw UnauthorizedError('invalid code');
    const row = await state.OtpChallenge.findOne({ phone });
    if (!row) throw UnauthorizedError('invalid or expired code');
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
      await state.OtpChallenge.deleteOne({ phone });
      throw UnauthorizedError('invalid or expired code');
    }

    // Increment attempts atomically. Read-modify-write would let two
    // concurrent wrong-code submissions both observe `attempts=N` and
    // both write `N+1`, undercounting by one. `$inc` makes the
    // increment server-side; we then delete when the post-increment
    // value crosses the 5-attempt threshold.
    const attemptedHash = sha256(code);
    const match = timingSafeHexEqual(attemptedHash, row.codeHash);
    if (!match) {
      const updated = await state.OtpChallenge.findOneAndUpdate(
        { phone },
        { $inc: { attempts: 1 } },
        { new: true }
      );
      if (updated && updated.attempts >= 5) {
        await state.OtpChallenge.deleteOne({ phone });
      }
      throw UnauthorizedError('invalid or expired code');
    }

    // Success — consume the challenge.
    await state.OtpChallenge.deleteOne({ phone });

    if (!state.User) throw UnauthorizedError('user model not available');
    // Upsert the user by phone. strict:false because the consumer's
    // User model may not have declared a `phone` field — model
    // evolution is consumer-owned.
    let user = await state.User.findOne({ phone });
    if (!user) {
      user = await state.User.create([{ phone, roles: ['user'] }], { strict: false })
        .then((arr) => Array.isArray(arr) ? arr[0] : arr);
    }

    if (!state.issueTokenPair) throw UnauthorizedError('token issuance not available');
    const { accessToken, refreshToken } = await state.issueTokenPair(user, req);

    res.status(200).json({
      accessToken,
      refreshToken,
      user: { _id: user._id, phone: user.phone || phone },
    });
  });

  return { send, verify };
}

module.exports = {
  buildOtpHandlers,
  generateCode,
  sha256,
  timingSafeHexEqual,
};
