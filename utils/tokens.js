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
 * presents a token that has already been revoked, we revoke every token in
 * its family — the assumption is the token has been stolen.
 */
async function rotateRefreshToken(presentedToken, req) {
  if (!presentedToken || typeof presentedToken !== 'string') {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const tokenHash = sha256(presentedToken);
  const record = await RefreshToken.findOne({ tokenHash });
  if (!record) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  // Reuse detection: a revoked token was just presented again. Revoke the
  // whole family so the attacker (or whichever client got out of sync) loses
  // access to the chain.
  if (record.revokedAt) {
    await RefreshToken.updateMany(
      { familyId: record.familyId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    throw new UnauthorizedError('Refresh token reuse detected');
  }

  if (record.expiresAt < new Date()) {
    throw new UnauthorizedError('Refresh token expired');
  }

  // Mint the replacement, link it back to the old via replacedByHash, and
  // mark the old as revoked.
  const User = require('../model/user');
  const user = await User.findById(record.userId).select('_id email');
  if (!user) throw new UnauthorizedError('User no longer exists');

  const newRefresh = generateRefreshToken();
  const newHash = sha256(newRefresh);

  await RefreshToken.create({
    userId: user._id,
    familyId: record.familyId,
    tokenHash: newHash,
    expiresAt: refreshExpiry(),
    userAgent: req?.get?.('user-agent') || null,
    ip: req?.ip || null,
  });

  record.revokedAt = new Date();
  record.replacedByHash = newHash;
  await record.save();

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
