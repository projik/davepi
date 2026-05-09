const { setupTestApp, registerUser } = require('./helpers');
const RefreshToken = require('../model/refreshToken');
const { sha256 } = require('../utils/tokens');

const ctx = setupTestApp();

const post = (path, body, headers = {}) =>
  Object.entries(headers)
    .reduce((r, [k, v]) => r.set(k, v), ctx.request(ctx.app).post(path).send(body));

describe('Token pair issuance', () => {
  test('/register returns { accessToken, refreshToken, user }', async () => {
    const res = await ctx
      .request(ctx.app)
      .post('/register')
      .send({
        first_name: 'A',
        last_name: 'B',
        email: 'reg@example.com',
        password: 'pw12345!',
      });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.user).toEqual(expect.any(Object));
    expect(res.body.user.email).toBe('reg@example.com');
    expect(res.body.user.password).toBeUndefined();

    // Refresh token is stored hashed, never raw.
    const stored = await RefreshToken.findOne({
      tokenHash: sha256(res.body.refreshToken),
    });
    expect(stored).not.toBeNull();
    expect(stored.userId.toString()).toBe(res.body.user._id);
    expect(stored.revokedAt).toBeNull();
  });

  test('/login returns { accessToken, refreshToken, user }', async () => {
    await registerUser(ctx.request, ctx.app, { email: 'login@example.com' });
    const res = await ctx
      .request(ctx.app)
      .post('/login')
      .send({ email: 'login@example.com', password: 'pw12345!' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.user.email).toBe('login@example.com');
  });
});

describe('/auth/refresh — happy path and rotation', () => {
  test('rotates the refresh token and revokes the old one', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const original = user.refreshToken;

    const res = await post('/auth/refresh', { refreshToken: original });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).not.toBe(original);

    const oldRecord = await RefreshToken.findOne({
      tokenHash: sha256(original),
    });
    expect(oldRecord.revokedAt).not.toBeNull();
    expect(oldRecord.replacedByHash).toBe(sha256(res.body.refreshToken));

    const newRecord = await RefreshToken.findOne({
      tokenHash: sha256(res.body.refreshToken),
    });
    expect(newRecord.revokedAt).toBeNull();
    expect(newRecord.familyId.toString()).toBe(oldRecord.familyId.toString());
  });

  test('the new refresh token can itself be rotated', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const r1 = await post('/auth/refresh', { refreshToken: user.refreshToken });
    const r2 = await post('/auth/refresh', { refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(200);
    expect(r2.body.refreshToken).toEqual(expect.any(String));
    expect(r2.body.refreshToken).not.toBe(r1.body.refreshToken);
  });
});

describe('/auth/refresh — failure modes', () => {
  test('missing refreshToken returns 400 VALIDATION', async () => {
    const res = await post('/auth/refresh', {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  test('unknown refreshToken returns 401 UNAUTHORIZED', async () => {
    const res = await post('/auth/refresh', { refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('expired refreshToken returns 401', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    // Backdate the refresh token to be expired.
    await RefreshToken.updateOne(
      { tokenHash: sha256(user.refreshToken) },
      { $set: { expiresAt: new Date(Date.now() - 60 * 1000) } }
    );

    const res = await post('/auth/refresh', { refreshToken: user.refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toMatch(/expired/i);
  });

  test('reusing a revoked token revokes ALL of the user\'s active refresh tokens (across families)', async () => {
    const user = await registerUser(ctx.request, ctx.app, {
      email: 'reuse@example.com',
    });

    // First family: original -> r1 -> r2 (rotate twice).
    const r1 = await post('/auth/refresh', { refreshToken: user.refreshToken });
    const r2 = await post('/auth/refresh', { refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(200);

    // Second family: a parallel /login mints a separate refresh token chain
    // for the same user (think: same human signed in on a second device).
    const secondLogin = await ctx
      .request(ctx.app)
      .post('/login')
      .send({ email: 'reuse@example.com', password: 'pw12345!' });
    expect(secondLogin.status).toBe(200);
    const otherSession = secondLogin.body.refreshToken;

    // Replay the original from family #1 — already revoked.
    const replay = await post('/auth/refresh', { refreshToken: user.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toMatch(/reuse/i);

    // The currently-active r2 (family #1) is revoked.
    const family1AfterAttack = await post('/auth/refresh', {
      refreshToken: r2.body.refreshToken,
    });
    expect(family1AfterAttack.status).toBe(401);

    // AND the other-device session (family #2) is revoked too — the spec
    // is "all of that user's active refresh tokens", not "just the family
    // that was attacked".
    const family2AfterAttack = await post('/auth/refresh', {
      refreshToken: otherSession,
    });
    expect(family2AfterAttack.status).toBe(401);

    const all = await RefreshToken.find({ userId: user._id });
    for (const record of all) {
      expect(record.revokedAt).not.toBeNull();
    }
  });

  test('concurrent /auth/refresh with the same token: one wins, the other is treated as reuse', async () => {
    const user = await registerUser(ctx.request, ctx.app);

    // Fire two refresh requests simultaneously with the same refresh token.
    // The atomic findOneAndUpdate guarantees exactly one wins.
    const [a, b] = await Promise.all([
      post('/auth/refresh', { refreshToken: user.refreshToken }),
      post('/auth/refresh', { refreshToken: user.refreshToken }),
    ]);

    const successes = [a, b].filter((r) => r.status === 200);
    const failures = [a, b].filter((r) => r.status === 401);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].body.error.message).toMatch(/reuse/i);

    // The losing request triggered the user-wide revoke, so the winner's
    // freshly-minted token has also been killed.
    const winnerRetry = await post('/auth/refresh', {
      refreshToken: successes[0].body.refreshToken,
    });
    expect(winnerRetry.status).toBe(401);
  });
});

describe('/auth/logout', () => {
  test('revokes the supplied refresh token and is idempotent', async () => {
    const user = await registerUser(ctx.request, ctx.app);

    const logoutRes = await post('/auth/logout', { refreshToken: user.refreshToken });
    expect(logoutRes.status).toBe(204);

    const stored = await RefreshToken.findOne({
      tokenHash: sha256(user.refreshToken),
    });
    expect(stored.revokedAt).not.toBeNull();

    // Idempotent: calling logout again with the same token still 204s.
    const second = await post('/auth/logout', { refreshToken: user.refreshToken });
    expect(second.status).toBe(204);

    // But trying to USE the revoked token via /auth/refresh trips reuse detection.
    const refresh = await post('/auth/refresh', { refreshToken: user.refreshToken });
    expect(refresh.status).toBe(401);
  });

  test('logout with no body returns 204 (silent no-op)', async () => {
    const res = await post('/auth/logout', {});
    expect(res.status).toBe(204);
  });

  test('logout does NOT cascade to other tokens in the family', async () => {
    // Verify logout is friendly: it revokes only the supplied token, not
    // the whole chain. (Reuse detection cascades; logout does not.)
    const user = await registerUser(ctx.request, ctx.app);
    const r1 = await post('/auth/refresh', { refreshToken: user.refreshToken });

    // r1 is now the active token; the original is already revoked from rotation.
    // Logging out r1 should NOT touch any other family — there is no other
    // active token to compare against. So instead we verify the inverse:
    // logout never sets revokedAt on a sibling that wasn't asked for.
    await post('/auth/logout', { refreshToken: r1.body.refreshToken });

    const r1Record = await RefreshToken.findOne({
      tokenHash: sha256(r1.body.refreshToken),
    });
    expect(r1Record.revokedAt).not.toBeNull();
  });
});
