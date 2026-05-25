'use strict';

/**
 * Find-or-create a local User for a freshly-fetched OAuth profile,
 * and persist the link in `oauth_identity`.
 *
 * Lookup order:
 *   1. By (provider, providerUserId) — this user already signed in
 *      with this provider before. Update lastLoginAt, return user.
 *   2. By email — a User exists locally (perhaps registered via
 *      /register, perhaps via a different provider). Link this new
 *      identity to that user. Two providers, one local user.
 *   3. Neither — mint a new local User with the configured default
 *      roles and a new oauth_identity row.
 *
 * Caller supplies `User` and `OAuthIdentity` mongoose models so this
 * function stays unit-testable (the tests pass in-memory stubs).
 *
 * Returns `{ user, identity, created }` where `created` is true iff a
 * new local User was minted (useful for plugin callers that want to
 * fire welcome flows on first sign-in only).
 */

async function findOrCreateUser({
  provider,
  profile,
  User,
  OAuthIdentity,
  defaultRoles = ['user'],
}) {
  if (!profile || !profile.providerUserId) {
    throw new Error('davepi-plugin-oauth: profile.providerUserId is required');
  }

  // 1. Existing link.
  const existingLink = await OAuthIdentity.findOne({
    provider,
    providerUserId: String(profile.providerUserId),
  });
  if (existingLink) {
    let user = await User.findById(existingLink.userId);
    if (!user) {
      // Edge case: link row points at a deleted user. Treat as if
      // the link doesn't exist — delete it and fall through to the
      // create path. Otherwise the user is wedged.
      await OAuthIdentity.deleteOne({ _id: existingLink._id });
    } else {
      existingLink.lastLoginAt = new Date();
      // Refresh denormalised email on the link row when it changes.
      if (profile.email && profile.email !== existingLink.email) {
        existingLink.email = profile.email;
      }
      await existingLink.save();
      return { user, identity: existingLink, created: false };
    }
  }

  // 2. Existing local user with this email — link, don't duplicate.
  if (profile.email) {
    const user = await User.findOne({ email: String(profile.email).toLowerCase() });
    if (user) {
      const identity = await OAuthIdentity.create({
        userId: user._id,
        provider,
        providerUserId: String(profile.providerUserId),
        email: profile.email || null,
        profile: profile.raw || null,
        linkedAt: new Date(),
        lastLoginAt: new Date(),
      });
      return { user, identity, created: false };
    }
  }

  // 3. New user.
  const userDoc = {
    first_name: profile.firstName || null,
    last_name:  profile.lastName  || null,
    email:      profile.email ? String(profile.email).toLowerCase() : null,
    roles:      Array.isArray(defaultRoles) && defaultRoles.length ? defaultRoles : ['user'],
  };
  const user = await User.create(userDoc);
  const identity = await OAuthIdentity.create({
    userId: user._id,
    provider,
    providerUserId: String(profile.providerUserId),
    email: profile.email || null,
    profile: profile.raw || null,
    linkedAt: new Date(),
    lastLoginAt: new Date(),
  });
  return { user, identity, created: true };
}

/**
 * Attach a provider identity to an already-authenticated user (the
 * /auth/{provider}/link flow). Idempotent: if the identity exists and
 * already points at this user, we just refresh lastLoginAt; if it
 * exists and points at a different user, we reject — silently
 * stealing another tenant's identity would be a footgun.
 */
async function linkIdentityToUser({
  provider,
  profile,
  userId,
  OAuthIdentity,
}) {
  if (!userId) {
    throw new Error('davepi-plugin-oauth: linkIdentityToUser requires userId');
  }
  const existing = await OAuthIdentity.findOne({
    provider,
    providerUserId: String(profile.providerUserId),
  });
  if (existing) {
    if (String(existing.userId) !== String(userId)) {
      const err = new Error(
        `oauth identity ${provider}:${profile.providerUserId} is already linked to a different user`
      );
      err.code = 'oauth_identity_owned_by_other';
      throw err;
    }
    existing.lastLoginAt = new Date();
    if (profile.email && profile.email !== existing.email) existing.email = profile.email;
    await existing.save();
    return { identity: existing, created: false };
  }
  const identity = await OAuthIdentity.create({
    userId,
    provider,
    providerUserId: String(profile.providerUserId),
    email: profile.email || null,
    profile: profile.raw || null,
    linkedAt: new Date(),
    lastLoginAt: new Date(),
  });
  return { identity, created: true };
}

module.exports = { findOrCreateUser, linkIdentityToUser };
