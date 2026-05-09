const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const RefreshToken = require('../model/refreshToken');
const { UnauthorizedError } = require('./errors');

const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TTL_DAYS = parseInt(
  process.env.REFRESH_TOKEN_TTL_DAYS || '30',
  10
);

const sha256 = (input) =>
  crypto.createHash('sha256').update(input).digest('hex');

const generateRefreshToken = () => crypto.randomBytes(48).toString('hex');

const signAccessToken = (user) =>
  jwt.sign(
    { user_id: user._id, email: user.email },
    process.env.TOKEN_KEY,
    { expiresIn: ACCESS_TTL }
  );

const refreshExpiry = () =>
  new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

/**
 * Issue a brand-new (access, refresh) pair, starting a new family. Used by
 * /register and /login.
 */
async function issueTokenPair(user, req) {
  const accessToken = signAccessToken(user);
  const refreshToken = generateRefreshToken();
  const familyId = new mongoose.Types.ObjectId();

  await RefreshToken.create({
    userId: user._id,
    familyId,
    tokenHash: sha256(refreshToken),
    expiresAt: refreshExpiry(),
    userAgent: req?.get?.('user-agent') || null,
    ip: req?.ip || null,
  });

  return { accessToken, refreshToken };
}

/**
 * Validate an incoming refresh token, rotate it (revoke + replace), and
 * return a fresh (access, refresh) pair. Detects token reuse: if a caller
 * presents a token that has already been revoked — or loses a race against
 * a concurrent /auth/refresh — we revoke EVERY active refresh token for
 * that user. The assumption is the token has been stolen.
 *
 * The atomic claim via findOneAndUpdate is load-bearing: two concurrent
 * /auth/refresh calls with the same valid token must not both succeed in
 * minting fresh tokens. The first request flips revokedAt and proceeds;
 * the loser sees an already-revoked record and is treated as reuse.
 */
async function rotateRefreshToken(presentedToken, req) {
  if (!presentedToken || typeof presentedToken !== 'string') {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const tokenHash = sha256(presentedToken);
  const now = new Date();

  // Atomically claim the token: only the request whose predicate matches
  // (token exists, not revoked, not expired) wins. Returns the pre-update
  // doc so we keep the original userId/familyId. Concurrent calls and
  // replays of revoked tokens fall through to the "investigate why we
  // didn't win" branch below.
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now } },
    { new: false }
  );

  if (!claimed) {
    const record = await RefreshToken.findOne({ tokenHash });
    if (!record) throw new UnauthorizedError('Invalid refresh token');
    if (record.expiresAt < now && !record.revokedAt) {
      throw new UnauthorizedError('Refresh token expired');
    }
    // Token was already revoked (replay) OR we lost a concurrent rotation
    // race. Both paths are treated as theft: revoke EVERY active refresh
    // token for this user, not just this family.
    await RefreshToken.updateMany(
      { userId: record.userId, revokedAt: null },
      { $set: { revokedAt: now } }
    );
    throw new UnauthorizedError('Refresh token reuse detected');
  }

  // We won the claim. Mint the replacement and link it via replacedByHash.
  const User = require('../model/user');
  const user = await User.findById(claimed.userId).select('_id email');
  if (!user) throw new UnauthorizedError('User no longer exists');

  const newRefresh = generateRefreshToken();
  const newHash = sha256(newRefresh);

  await RefreshToken.create({
    userId: user._id,
    familyId: claimed.familyId,
    tokenHash: newHash,
    expiresAt: refreshExpiry(),
    userAgent: req?.get?.('user-agent') || null,
    ip: req?.ip || null,
  });

  await RefreshToken.updateOne(
    { _id: claimed._id },
    { $set: { replacedByHash: newHash } }
  );

  return {
    accessToken: signAccessToken(user),
    refreshToken: newRefresh,
  };
}

/**
 * Revoke a single refresh token (logout). Idempotent: returns silently
 * whether or not the token was already revoked. We deliberately do NOT
 * trigger the family-wide revoke here — logout is a friendly operation,
 * not evidence of theft.
 */
async function revokeRefreshToken(presentedToken) {
  if (!presentedToken || typeof presentedToken !== 'string') return;
  const tokenHash = sha256(presentedToken);
  await RefreshToken.updateOne(
    { tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

module.exports = {
  ACCESS_TTL,
  REFRESH_TTL_DAYS,
  signAccessToken,
  generateRefreshToken,
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  // exported for tests
  sha256,
};
