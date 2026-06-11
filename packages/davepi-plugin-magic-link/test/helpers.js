'use strict';

/**
 * Shared in-memory stubs for the unit suite. No Express, no Mongoose,
 * no davepi — the same standalone posture as the other plugin
 * packages' tests.
 */

class StubValidationError extends Error {
  constructor(m) { super(m); this.status = 400; this.code = 'VALIDATION'; }
}
class StubUnauthorizedError extends Error {
  constructor(m) { super(m); this.status = 401; this.code = 'UNAUTHORIZED'; }
}
class StubForbiddenError extends Error {
  constructor(m) { super(m); this.status = 403; this.code = 'FORBIDDEN'; }
}
const stubErrors = {
  ValidationError: StubValidationError,
  UnauthorizedError: StubUnauthorizedError,
  ForbiddenError: StubForbiddenError,
};

function silentLog() {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  return log;
}

function memUserModel() {
  const byId = new Map();
  const byEmail = new Map();
  let seq = 1;
  return {
    byId,
    byEmail,
    failNextCreateWith: null,
    async findOne(q) {
      if (q.email) return byEmail.get(q.email) || null;
      return null;
    },
    async findById(id) {
      return byId.get(String(id)) || null;
    },
    async create(doc) {
      if (this.failNextCreateWith) {
        const err = this.failNextCreateWith;
        this.failNextCreateWith = null;
        throw err;
      }
      const _id = 'u' + seq++;
      const user = { _id, ...doc };
      byId.set(_id, user);
      byEmail.set(user.email, user);
      return user;
    },
  };
}

function memTokenModel() {
  const rows = [];
  return {
    rows,
    failNextCreateWith: null,
    async create(doc) {
      if (this.failNextCreateWith) {
        const err = this.failNextCreateWith;
        this.failNextCreateWith = null;
        throw err;
      }
      const row = { _id: 't' + (rows.length + 1), usedAt: null, ...doc };
      rows.push(row);
      return row;
    },
    async findOneAndUpdate(q, update, opts) {
      const now = q.expiresAt && q.expiresAt.$gt;
      const row = rows.find(
        (r) =>
          r.tokenHash === q.tokenHash &&
          r.usedAt === q.usedAt &&
          (!now || r.expiresAt > now)
      );
      if (!row) return null;
      const before = { ...row };
      if (update.$set) Object.assign(row, update.$set);
      return opts && opts.new ? row : before;
    },
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    ended: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}

function captureNext() {
  const captured = { err: null };
  return { next: (e) => { captured.err = e; }, captured };
}

function buildHarness({ env, authoriseInvite } = {}) {
  const { createPlugin } = require('../index');
  const User = memUserModel();
  const MagicLinkToken = memTokenModel();
  const mails = [];
  const harness = { failNextSendMailWith: null };
  const plugin = createPlugin({
    env: {
      MAGIC_LINK_URL: 'https://app.example.com/auth/verify',
      APP_NAME: 'TestApp',
      ...env,
    },
    errors: stubErrors,
    User,
    MagicLinkToken,
    issueTokenPair: async (user) => ({
      accessToken: 'AT.' + user._id,
      refreshToken: 'RT.' + user._id,
    }),
    sendMail: async (mail) => {
      if (harness.failNextSendMailWith) {
        const err = harness.failNextSendMailWith;
        harness.failNextSendMailWith = null;
        throw err;
      }
      mails.push(mail);
    },
    bcrypt: { hash: async () => 'hashed-password' },
    verifyAuth: () => (req, res, next) => next(),
    authLimiter: (req, res, next) => next(),
    authoriseInvite,
    log: silentLog(),
  });
  Object.assign(harness, { plugin, User, MagicLinkToken, mails });
  return harness;
}

// Routes-mounted harness: runs setup() against a fake Express app and
// returns the recorded route table.
async function buildMountedHarness(opts = {}) {
  const h = buildHarness(opts);
  const routes = new Map();
  const app = {
    post(path, ...mws) {
      routes.set(path, mws);
    },
  };
  await h.plugin.setup({ app, appName: 'FallbackApp', log: silentLog() });
  // Run a request through every middleware in the chain, mirroring
  // Express's next() walk: advance while next() is called without an
  // error, stop when a middleware errors or writes the response.
  async function dispatch(path, req) {
    const chain = routes.get(path);
    if (!chain) throw new Error('no route mounted at ' + path);
    const res = fakeRes();
    const captured = { err: null };
    for (const mw of chain) {
      let advanced = false;
      await mw(req, res, (err) => {
        if (err) captured.err = err;
        else advanced = true;
      });
      if (captured.err || !advanced) break;
    }
    return { res, captured };
  }
  Object.assign(h, { app, routes, dispatch });
  return h;
}

module.exports = {
  stubErrors,
  StubValidationError,
  StubUnauthorizedError,
  StubForbiddenError,
  silentLog,
  memUserModel,
  memTokenModel,
  fakeRes,
  captureNext,
  buildHarness,
  buildMountedHarness,
};
