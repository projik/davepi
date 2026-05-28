'use strict';

/**
 * OTP handler tests. We build the handlers directly via the plugin
 * factory + stub models (no Express, no Mongoose, no Twilio). Each
 * stub model holds an in-memory map keyed by phone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createPlugin } = require('../index');
const { sha256, generateCode } = require('../lib/otp');

class StubValidationError   extends Error { constructor(m){super(m);this.status=400;this.code='VALIDATION';} }
class StubUnauthorizedError extends Error { constructor(m){super(m);this.status=401;this.code='UNAUTHORIZED';} }
class StubForbiddenError    extends Error { constructor(m){super(m);this.status=403;this.code='FORBIDDEN';} }
class StubNotFoundError     extends Error { constructor(m){super(m);this.status=404;this.code='NOT_FOUND';} }
const stubErrors = {
  ValidationError: StubValidationError,
  UnauthorizedError: StubUnauthorizedError,
  ForbiddenError: StubForbiddenError,
  NotFoundError: StubNotFoundError,
};

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLog() };
}

function memOtpChallenge() {
  const rows = new Map();
  return {
    rows,
    async findOne(q) { return rows.get(q.phone) || null; },
    async findOneAndUpdate(q, update, opts) {
      const existing = rows.get(q.phone) || null;
      const next = { ...(existing || {}) };
      if (update.$set) Object.assign(next, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          next[k] = (next[k] || 0) + v;
        }
      }
      rows.set(q.phone, next);
      return opts && opts.new ? next : existing;
    },
    async deleteOne(q) { rows.delete(q.phone); return { deletedCount: 1 }; },
  };
}

function memOtpRate() {
  const rows = new Map();
  // Mongo-pipeline-shape stub: enough $cond / $or / $eq / $ifNull /
  // $lte / $add support to drive the OTP rate limiter. Kept here
  // (not in lib/) because production code uses real Mongo — this is
  // a single-purpose evaluator just for the in-memory test path.
  function evalExpr(expr, ctx) {
    if (expr === null || expr === undefined) return expr;
    if (typeof expr === 'string' && expr.startsWith('$')) {
      return ctx[expr.slice(1)];
    }
    if (typeof expr !== 'object') return expr;
    if (Array.isArray(expr)) return expr.map((e) => evalExpr(e, ctx));
    const keys = Object.keys(expr);
    if (keys.length === 1 && keys[0].startsWith('$')) {
      const op = keys[0];
      const args = expr[op];
      const evalArgs = (a) => Array.isArray(a) ? a.map((x) => evalExpr(x, ctx)) : evalExpr(a, ctx);
      switch (op) {
        case '$cond':   { const [c, t, f] = evalArgs(args); return c ? t : f; }
        case '$or':     return evalArgs(args).some(Boolean);
        case '$and':    return evalArgs(args).every(Boolean);
        case '$not':    return !evalArgs(args)[0];
        case '$eq':     { const [a, b] = evalArgs(args); return a === b || (a == null && b == null); }
        case '$lte':    { const [a, b] = evalArgs(args); if (a == null) return false; return new Date(a) <= new Date(b); }
        case '$ifNull': { const [a, b] = evalArgs(args); return a == null ? b : a; }
        case '$add':    return evalArgs(args).reduce((s, n) => s + (n || 0), 0);
        default: throw new Error('memOtpRate: unsupported op ' + op);
      }
    }
    // Plain object literal — just substitute string field refs.
    const out = {};
    for (const k of Object.keys(expr)) out[k] = evalExpr(expr[k], ctx);
    return out;
  }
  return {
    rows,
    async findOneAndUpdate(filter, update, opts) {
      const phone = filter.phone;
      const existing = rows.get(phone) || null;
      const now = new Date();
      // live-only $inc branch (used by the refund path)
      const liveOnly = filter.expiresAt && filter.expiresAt.$gt;
      if (liveOnly) {
        if (!existing || new Date(existing.expiresAt) <= now) return null;
        if (filter.count && filter.count.$gt != null && !((existing.count || 0) > filter.count.$gt)) return null;
        if (update.$inc) {
          for (const [k, v] of Object.entries(update.$inc)) existing[k] = (existing[k] || 0) + v;
        }
        rows.set(phone, existing);
        return opts && opts.new ? existing : { ...existing };
      }
      // Aggregation pipeline upsert (the OTP rate limiter).
      if (Array.isArray(update)) {
        const ctx = existing ? { ...existing } : {};
        let next = { ...ctx };
        for (const stage of update) {
          if (stage.$set) {
            for (const [k, v] of Object.entries(stage.$set)) next[k] = evalExpr(v, next);
          }
        }
        rows.set(phone, next);
        return opts && opts.new ? next : existing;
      }
      // Plain $set / $inc upsert (legacy path).
      const next = { ...(existing || {}) };
      if (update.$set) Object.assign(next, update.$set);
      if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) next[k] = (next[k] || 0) + v;
      rows.set(phone, next);
      return opts && opts.new ? next : existing;
    },
  };
}

function memUserModel() {
  const byId = new Map();
  const byPhone = new Map();
  let seq = 1;
  const m = {
    byId, byPhone,
    async findOne(q) {
      if (q.phone) return byPhone.get(q.phone) || null;
      if (q._id) return byId.get(String(q._id)) || null;
      return null;
    },
    async findById(id) { return byId.get(String(id)) || null; },
    async findByIdAndUpdate(id, update, _opts) {
      const u = byId.get(String(id));
      if (!u) return null;
      Object.assign(u, update.$set || {});
      if (update.$unset) for (const k of Object.keys(update.$unset)) delete u[k];
      return u;
    },
    async create(arr) {
      const list = Array.isArray(arr) ? arr : [arr];
      const created = list.map((doc) => {
        const _id = doc._id || ('u' + (seq++));
        const u = { _id, ...doc };
        byId.set(String(_id), u);
        if (u.phone) byPhone.set(u.phone, u);
        return u;
      });
      return Array.isArray(arr) ? created : created[0];
    },
  };
  return m;
}

function buildHarness({ env, smsMock, attemptsAllowed }) {
  const OtpChallenge = memOtpChallenge();
  const OtpRate = memOtpRate();
  const User = memUserModel();
  const issueTokenPair = async (user) => ({
    accessToken: 'AT.' + user._id,
    refreshToken: 'RT.' + user._id,
  });

  // We bypass the real sendSms (which would route through ensureEnabled +
  // the real Twilio client). Build the plugin with an inert twilioClient,
  // then monkey-patch its sendSms method for handler-driven tests.
  const client = {
    messages: { create: async () => ({ sid: 'SMx' }) },
    validateRequest: () => true,
  };

  const plugin = require('../index').createPlugin({
    env: {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_FROM_NUMBER: '+12025550100',
      TOKEN_KEY: 'unit-test-token-key',
      OTP_MAX_ATTEMPTS_PER_HOUR: '3',
      OTP_TTL_SECONDS: '60',
      ...env,
    },
    twilioClient: client,
    errors: stubErrors,
    OtpChallenge,
    OtpRate,
    User,
    issueTokenPair,
  });

  // We don't call plugin.setup() (no Express app needed). Instead we
  // build the OTP handlers directly.
  const { buildOtpHandlers } = require('../lib/otp');
  const sendSms = smsMock || (async () => ({ sid: 'SMx' }));
  // We need the same state object the plugin uses. Reach in via
  // plugin._state.
  // First, populate state.enabled-ish fields so handlers don't bail.
  plugin._state.appName = 'TestApp';
  plugin._state.errors = stubErrors;
  plugin._state.OtpChallenge = OtpChallenge;
  plugin._state.OtpRate = OtpRate;
  plugin._state.User = User;
  plugin._state.issueTokenPair = issueTokenPair;
  plugin._state.config.tokenKey = 'unit-test-token-key';

  const handlers = buildOtpHandlers({
    config: plugin._state.config,
    state: plugin._state,
    sendSms,
  });
  return { plugin, handlers, OtpChallenge, OtpRate, User };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function captureNext() {
  const c = { err: null };
  return { next: (e) => { c.err = e; }, captured: c };
}

const PHONE = '+12025550199';

test('OTP send: rejects malformed phone with ValidationError', async () => {
  const h = buildHarness({});
  const req = { body: { phone: 'not-a-number' } };
  const res = fakeRes();
  const { next, captured } = captureNext();
  await h.handlers.send(req, res, next);
  assert.ok(captured.err instanceof StubValidationError, 'should ValidationError; got ' + (captured.err && captured.err.message));
  assert.equal(res.statusCode, null);
});

test('OTP send: happy path stores hashed code and calls sendSms with appName-prefixed body', async () => {
  const smsCalls = [];
  const h = buildHarness({ smsMock: async (m) => { smsCalls.push(m); return { sid: 'SMok' }; } });

  const req = { body: { phone: PHONE } };
  const res = fakeRes();
  const { next, captured } = captureNext();
  await h.handlers.send(req, res, next);

  assert.equal(captured.err, null, 'should not error; got: ' + (captured.err && captured.err.message));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.expiresInSeconds, 'number');

  // Stored row has a hashed code (sha256 hex == 64 chars), not the plaintext.
  const row = h.OtpChallenge.rows.get(PHONE);
  assert.ok(row);
  assert.equal(row.codeHash.length, 64);
  assert.equal(row.attempts, 0);

  // SMS called with the code in the body, prefixed with appName.
  assert.equal(smsCalls.length, 1);
  assert.equal(smsCalls[0].to, PHONE);
  assert.match(smsCalls[0].body, /^TestApp code: \d{6}$/);
});

test('OTP send: rate-limit returns ForbiddenError after OTP_MAX_ATTEMPTS_PER_HOUR', async () => {
  const h = buildHarness({ smsMock: async () => ({ sid: 'x' }) });
  for (let i = 0; i < 3; i++) {
    const res = fakeRes();
    const { next, captured } = captureNext();
    await h.handlers.send({ body: { phone: PHONE } }, res, next);
    assert.equal(captured.err, null, `iter ${i}: unexpected error`);
    assert.equal(res.statusCode, 200);
  }
  const res = fakeRes();
  const { next, captured } = captureNext();
  await h.handlers.send({ body: { phone: PHONE } }, res, next);
  assert.ok(captured.err instanceof StubForbiddenError);
  assert.match(captured.err.message, /rate limit/i);
});

test('OTP verify: wrong code returns UnauthorizedError and increments attempts', async () => {
  const h = buildHarness({ smsMock: async () => ({ sid: 'x' }) });
  await h.handlers.send({ body: { phone: PHONE } }, fakeRes(), () => {});
  const row = h.OtpChallenge.rows.get(PHONE);
  assert.equal(row.attempts, 0);

  const res = fakeRes();
  const { next, captured } = captureNext();
  await h.handlers.verify({ body: { phone: PHONE, code: '000000' } }, res, next);
  assert.ok(captured.err instanceof StubUnauthorizedError);
  assert.equal(h.OtpChallenge.rows.get(PHONE).attempts, 1);
});

test('OTP verify: 5th failed attempt deletes the row', async () => {
  const h = buildHarness({ smsMock: async () => ({ sid: 'x' }) });
  await h.handlers.send({ body: { phone: PHONE } }, fakeRes(), () => {});

  for (let i = 0; i < 5; i++) {
    const { next } = captureNext();
    await h.handlers.verify({ body: { phone: PHONE, code: '999999' } }, fakeRes(), next);
  }
  assert.equal(h.OtpChallenge.rows.has(PHONE), false);
});

test('OTP verify: expired challenge deletes row and returns UnauthorizedError', async () => {
  const h = buildHarness({ smsMock: async () => ({ sid: 'x' }) });
  // Inject a stale row directly.
  h.OtpChallenge.rows.set(PHONE, {
    phone: PHONE,
    codeHash: sha256('123456'),
    attempts: 0,
    expiresAt: new Date(Date.now() - 1000),
  });
  const { next, captured } = captureNext();
  await h.handlers.verify({ body: { phone: PHONE, code: '123456' } }, fakeRes(), next);
  assert.ok(captured.err instanceof StubUnauthorizedError);
  assert.equal(h.OtpChallenge.rows.has(PHONE), false);
});

test('OTP verify: correct code mints JWT and upserts a User by phone', async () => {
  const captured = {};
  const h = buildHarness({
    smsMock: async (m) => { captured.body = m.body; return { sid: 'x' }; },
  });
  await h.handlers.send({ body: { phone: PHONE } }, fakeRes(), () => {});
  const code = captured.body.match(/code: (\d{6})/)[1];

  const res = fakeRes();
  const { next, captured: ec } = captureNext();
  await h.handlers.verify({ body: { phone: PHONE, code } }, res, next);
  assert.equal(ec.err, null, 'should not error; got ' + (ec.err && ec.err.message));
  assert.equal(res.statusCode, 200);
  assert.match(res.body.accessToken, /^AT\./);
  assert.match(res.body.refreshToken, /^RT\./);
  assert.equal(res.body.user.phone, PHONE);
  // Challenge consumed.
  assert.equal(h.OtpChallenge.rows.has(PHONE), false);
  // User exists.
  assert.equal(h.User.byPhone.has(PHONE), true);
});

test('OTP send: SMS dispatch failure deletes the stored challenge and refunds the rate window', async () => {
  const h = buildHarness({
    smsMock: async () => { throw new Error('twilio down'); },
  });
  const res = fakeRes();
  const { next, captured } = captureNext();
  await h.handlers.send({ body: { phone: PHONE } }, res, next);

  // 503 propagated…
  assert.ok(captured.err);
  assert.equal(captured.err.status, 503);
  assert.equal(captured.err.code, 'SMS_UNAVAILABLE');
  // …challenge row cleaned up…
  assert.equal(h.OtpChallenge.rows.has(PHONE), false);
  // …rate window refunded to 0 so the user can retry immediately.
  const rate = h.OtpRate.rows.get(PHONE);
  assert.ok(rate);
  assert.equal(rate.count, 0);
});

test('generateCode produces N-digit zero-padded strings', () => {
  for (let i = 0; i < 50; i++) {
    const c = generateCode(6);
    assert.equal(c.length, 6);
    assert.match(c, /^\d{6}$/);
  }
  const c8 = generateCode(8);
  assert.equal(c8.length, 8);
  assert.match(c8, /^\d{8}$/);
});
