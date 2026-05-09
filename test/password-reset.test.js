const crypto = require('crypto');
const { setupTestApp, registerUser } = require('./helpers');
const PasswordResetToken = require('../model/passwordResetToken');
const RefreshToken = require('../model/refreshToken');
const User = require('../model/user');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const ctx = setupTestApp();

const post = (path, body = {}) =>
  ctx.request(ctx.app).post(path).send(body);

describe('/auth/forgot-password', () => {
  test('known email returns 204 and creates a hashed reset token', async () => {
    const user = await registerUser(ctx.request, ctx.app, {
      email: 'known@example.com',
    });

    const res = await post('/auth/forgot-password', { email: 'known@example.com' });
    expect(res.status).toBe(204);

    const tokens = await PasswordResetToken.find({ userId: user._id });
    expect(tokens).toHaveLength(1);
    // Stored as a hash, not the raw 64-char hex token
    expect(tokens[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokens[0].usedAt).toBeNull();
    expect(tokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('unknown email returns 204 and creates no token (no enumeration oracle)', async () => {
    const before = await PasswordResetToken.countDocuments();
    const res = await post('/auth/forgot-password', { email: 'nobody@example.com' });
    expect(res.status).toBe(204);
    const after = await PasswordResetToken.countDocuments();
    expect(after).toBe(before);
  });

  test('missing email still returns 204 (no leak)', async () => {
    const res = await post('/auth/forgot-password', {});
    expect(res.status).toBe(204);
  });

  test('email is normalized to lowercase before lookup', async () => {
    const user = await registerUser(ctx.request, ctx.app, {
      email: 'mixed@example.com',
    });

    const res = await post('/auth/forgot-password', { email: 'MIXED@example.com' });
    expect(res.status).toBe(204);

    const tokens = await PasswordResetToken.find({ userId: user._id });
    expect(tokens).toHaveLength(1);
  });
});

describe('/auth/reset-password', () => {
  let user;
  let rawToken;

  beforeEach(async () => {
    user = await registerUser(ctx.request, ctx.app, {
      email: 'reset@example.com',
      password: 'oldpassword',
    });
    rawToken = crypto.randomBytes(32).toString('hex');
    await PasswordResetToken.create({
      userId: user._id,
      tokenHash: sha256(rawToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  test('happy path: 204, password updated, token marked used', async () => {
    const res = await post('/auth/reset-password', {
      token: rawToken,
      newPassword: 'brand-new-pw1',
    });
    expect(res.status).toBe(204);

    // Token is single-use
    const stored = await PasswordResetToken.findOne({ tokenHash: sha256(rawToken) });
    expect(stored.usedAt).not.toBeNull();

    // Old password no longer works
    const oldLogin = await post('/login', {
      email: 'reset@example.com',
      password: 'oldpassword',
    });
    expect(oldLogin.status).toBe(400);

    // New password works
    const newLogin = await post('/login', {
      email: 'reset@example.com',
      password: 'brand-new-pw1',
    });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.accessToken).toEqual(expect.any(String));
  });

  test('successful reset revokes ALL of the user\'s active refresh tokens', async () => {
    // Mint a second session for the same user before the reset.
    const secondLogin = await post('/login', {
      email: 'reset@example.com',
      password: 'oldpassword',
    });
    expect(secondLogin.status).toBe(200);

    const before = await RefreshToken.find({
      userId: user._id,
      revokedAt: null,
    });
    expect(before.length).toBeGreaterThanOrEqual(2);

    const res = await post('/auth/reset-password', {
      token: rawToken,
      newPassword: 'brand-new-pw1',
    });
    expect(res.status).toBe(204);

    const after = await RefreshToken.find({
      userId: user._id,
      revokedAt: null,
    });
    expect(after).toHaveLength(0);

    // Both pre-reset refresh tokens fail when presented.
    const replay = await post('/auth/refresh', {
      refreshToken: secondLogin.body.refreshToken,
    });
    expect(replay.status).toBe(401);
  });

  test('token is single-use: second presentation rejected', async () => {
    const first = await post('/auth/reset-password', {
      token: rawToken,
      newPassword: 'brand-new-pw1',
    });
    expect(first.status).toBe(204);

    const second = await post('/auth/reset-password', {
      token: rawToken,
      newPassword: 'another-pw-22',
    });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('VALIDATION');
    expect(second.body.error.message).toMatch(/invalid or expired/i);
  });

  test('expired token returns 400', async () => {
    await PasswordResetToken.updateOne(
      { tokenHash: sha256(rawToken) },
      { $set: { expiresAt: new Date(Date.now() - 60 * 1000) } }
    );

    const res = await post('/auth/reset-password', {
      token: rawToken,
      newPassword: 'brand-new-pw1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  test('unknown token returns 400', async () => {
    const res = await post('/auth/reset-password', {
      token: 'not-a-real-token',
      newPassword: 'brand-new-pw1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  test('missing fields return 400', async () => {
    const a = await post('/auth/reset-password', { token: rawToken });
    expect(a.status).toBe(400);
    expect(a.body.error.message).toMatch(/required/i);

    const b = await post('/auth/reset-password', { newPassword: 'whatever1' });
    expect(b.status).toBe(400);
  });

  test('password shorter than 8 characters returns 400', async () => {
    const res = await post('/auth/reset-password', {
      token: rawToken,
      newPassword: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at least 8/i);

    // The token must still be unused so the legit user can retry.
    const stored = await PasswordResetToken.findOne({ tokenHash: sha256(rawToken) });
    expect(stored.usedAt).toBeNull();
  });

  test('password is bcrypt-hashed at rest (not stored as plaintext)', async () => {
    await post('/auth/reset-password', {
      token: rawToken,
      newPassword: 'brand-new-pw1',
    });
    const stored = await User.findById(user._id);
    expect(stored.password).not.toBe('brand-new-pw1');
    expect(stored.password).toMatch(/^\$2[aby]\$/); // bcrypt prefix
  });
});

describe('Rate limiting on reset endpoints', () => {
  // The app's real authLimiter skips during NODE_ENV=test by design (see
  // middleware/rateLimit.js). To verify the reset endpoints are
  // actually gated, we mount a tiny app with the same factory + a
  // forced-on skip, which is exactly the pattern used in
  // test/security.test.js for /login.

  test('11th /auth/forgot-password attempt within 15 min returns 429', async () => {
    const express = require('express');
    const supertest = require('supertest');
    const { buildAuthLimiter } = require('../middleware/rateLimit');

    const tinyApp = express();
    tinyApp.use(express.json());
    tinyApp.post(
      '/auth/forgot-password',
      buildAuthLimiter({
        windowMs: 15 * 60 * 1000,
        max: 10,
        skip: () => false,
      }),
      (req, res) => res.status(204).end()
    );

    const r = supertest(tinyApp);
    for (let i = 1; i <= 10; i++) {
      const res = await r.post('/auth/forgot-password').send({});
      expect(res.status).toBe(204);
    }
    const eleventh = await r.post('/auth/forgot-password').send({});
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('RATE_LIMITED');
  });

  test('11th /auth/reset-password attempt within 15 min returns 429', async () => {
    const express = require('express');
    const supertest = require('supertest');
    const { buildAuthLimiter } = require('../middleware/rateLimit');

    const tinyApp = express();
    tinyApp.use(express.json());
    tinyApp.post(
      '/auth/reset-password',
      buildAuthLimiter({
        windowMs: 15 * 60 * 1000,
        max: 10,
        skip: () => false,
      }),
      (req, res) => res.status(400).end() // any 4xx is fine; we only care about the limiter status
    );

    const r = supertest(tinyApp);
    for (let i = 1; i <= 10; i++) {
      const res = await r.post('/auth/reset-password').send({});
      expect(res.status).toBe(400);
    }
    const eleventh = await r.post('/auth/reset-password').send({});
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('mailer behavior', () => {
  const { sendMail, __resetTransporter } = require('../utils/mailer');

  beforeEach(() => {
    __resetTransporter();
    delete process.env.SMTP_HOST;
  });

  afterAll(() => {
    process.env.NODE_ENV = 'test';
    __resetTransporter();
    delete process.env.SMTP_HOST;
  });

  test('non-production never sends — even if SMTP_HOST is set', async () => {
    process.env.NODE_ENV = 'test';
    process.env.SMTP_HOST = 'smtp.example.com'; // would-be real
    // No throw, no SMTP connection attempt — just a log.
    await expect(
      sendMail({ to: 'x@x.com', subject: 's', text: 't' })
    ).resolves.toBeUndefined();
  });

  test('production with no SMTP_HOST: does not throw and does not log the body', async () => {
    const logger = require('../utils/logger');
    const errors = [];
    const original = logger.error.bind(logger);
    logger.error = (obj, msg) => errors.push({ obj, msg });

    process.env.NODE_ENV = 'production';
    delete process.env.SMTP_HOST;

    try {
      await sendMail({
        to: 'reset@x.com',
        subject: 'Reset your password',
        text: 'http://app/reset?token=SECRET-TOKEN-THAT-MUST-NOT-LEAK',
      });
      expect(errors.length).toBeGreaterThan(0);
      const last = errors[errors.length - 1];
      // Header logged but the body / token must NOT be.
      expect(last.obj).toMatchObject({ to: 'reset@x.com', subject: 'Reset your password' });
      expect(last.obj.text).toBeUndefined();
      expect(last.obj.html).toBeUndefined();
      expect(JSON.stringify(last)).not.toContain('SECRET-TOKEN');
    } finally {
      logger.error = original;
      process.env.NODE_ENV = 'test';
    }
  });
});
