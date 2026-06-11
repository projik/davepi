'use strict';

/**
 * Route handlers for davepi-plugin-magic-link.
 *
 * Built as a factory over the plugin's `state` so the package's own
 * unit suite can drive them with stub models and no Express /
 * Mongoose / davepi install — the same pattern as
 * davepi-plugin-twilio's `lib/otp.js`.
 */

const crypto = require('crypto');

const sha256 = (input) =>
  crypto.createHash('sha256').update(input).digest('hex');

const generateToken = () => crypto.randomBytes(32).toString('hex');

// Light-touch shape check only. The real validation is that the
// address receives the email — over-strict regexes reject valid
// addresses and add nothing: a mistyped address simply never gets
// the link.
const looksLikeEmail = (value) =>
  typeof value === 'string' &&
  value.length <= 320 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/**
 * Build the verify URL. Two supported `MAGIC_LINK_URL` shapes,
 * mirroring oauth's `appendTokenToRedirect`:
 *   - URL ending in `=` (e.g. `https://app/auth/verify?token=`):
 *     concatenate — the token is hex, so URL-safe.
 *   - Otherwise: append as `?token=...` or `&token=...`.
 */
function buildVerifyUrl(baseUrl, token) {
  if (baseUrl.endsWith('=')) return `${baseUrl}${token}`;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}token=${token}`;
}

function serialiseUser(user) {
  if (!user) return null;
  return {
    _id: user._id,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    roles: user.roles,
  };
}

function buildMagicLinkHandlers({ config, state }) {
  /**
   * Find a user by email or create one. New users get an unguessable
   * random password (bcrypt-hashed) they never learn — sign-in is by
   * link only. A concurrent create race for the same NEW email loses
   * to the unique email index (E11000); re-query so the caller still
   * gets a user and the request route keeps its "always 204"
   * no-enumeration contract.
   */
  async function findOrCreateUser(email, name) {
    const lower = String(email).toLowerCase().trim();
    const existing = await state.User.findOne({ email: lower });
    if (existing) return existing;
    if (!config.allowSignup) return null;
    const [first, ...rest] = String(name || '').trim().split(/\s+/);
    const password = await state.bcrypt.hash(
      crypto.randomBytes(24).toString('hex'),
      10
    );
    try {
      return await state.User.create({
        first_name: first || 'Member',
        last_name: rest.join(' '),
        email: lower,
        password,
        roles: config.defaultRoles,
      });
    } catch (err) {
      if (err && err.code === 11000) return state.User.findOne({ email: lower });
      throw err;
    }
  }

  /**
   * Mint a single-use token row and return the raw token. Only the
   * SHA-256 hash is persisted.
   */
  async function issueMagicLink({ email, userId, purpose, meta } = {}) {
    const raw = generateToken();
    await state.MagicLinkToken.create({
      email: email ? String(email).toLowerCase().trim() : undefined,
      tokenHash: sha256(raw),
      purpose: purpose || 'login',
      userId: userId != null ? String(userId) : undefined,
      meta: meta ?? null,
      expiresAt: new Date(Date.now() + config.ttlMinutes * 60_000),
    });
    return raw;
  }

  /**
   * POST <path>/request  { email, name? }
   *
   * Always 204 — the response never reveals whether the email already
   * has an account, and (with MAGIC_LINK_ALLOW_SIGNUP=false) never
   * reveals that signup was refused either.
   */
  async function request(req, res, next) {
    const { email, name } = req.body || {};
    if (!looksLikeEmail(email)) {
      return next(new state.errors.ValidationError('a valid email is required'));
    }
    try {
      const user = await findOrCreateUser(email, name);
      if (user) {
        const raw = await issueMagicLink({
          email: user.email,
          userId: user._id,
          purpose: 'login',
        });
        await state.sendMail({
          to: user.email,
          subject: `Your ${state.appName} sign-in link`,
          text:
            `Sign in to ${state.appName} within ${config.ttlMinutes} minutes:\n\n` +
            `${buildVerifyUrl(config.url, raw)}\n\n` +
            `If you didn't request this, you can ignore this email.`,
        });
      }
    } catch (err) {
      state.log.error({ err, plugin: 'magic-link' }, 'request: internal error swallowed to preserve 204 contract');
    }
    res.status(204).end();
  }

  /**
   * POST <path>/invite  { email, name?, note?, meta? }  (authenticated)
   *
   * Generic invite: arbitrary `meta` rides on the token and is
   * returned at verify. Because `meta` is caller-supplied, it is
   * REFUSED unless the consumer has registered an authoriser via
   * `registerInviteAuthoriser` — the safe default against
   * confused-deputy injection (a caller smuggling ids they don't
   * own into another user's session).
   *
   * The authoriser is `async (req, { email, meta })`; it throws to
   * refuse, and may return `{ userId }` to bind the link to a
   * specific account (e.g. a shared-account app inviting a second
   * member into the inviter's own user). When it returns nothing,
   * the invitee gets their own find-or-create account.
   */
  async function invite(req, res, next) {
    try {
      const { email, name, note, meta } = req.body || {};
      if (!looksLikeEmail(email)) {
        throw new state.errors.ValidationError('a valid email is required');
      }
      if (meta != null && typeof state.authoriseInvite !== 'function') {
        throw new state.errors.ForbiddenError(
          'invite meta is not enabled (the host app has not registered an invite authoriser)'
        );
      }
      let boundUserId = null;
      if (typeof state.authoriseInvite === 'function') {
        const outcome = await state.authoriseInvite(req, { email, meta });
        if (outcome && outcome.userId != null) boundUserId = String(outcome.userId);
      }
      if (!boundUserId) {
        const user = await findOrCreateUser(email, name);
        if (!user) {
          throw new state.errors.ForbiddenError(
            'signup is disabled and the invited email has no account'
          );
        }
        boundUserId = String(user._id);
      }
      const raw = await issueMagicLink({
        email,
        userId: boundUserId,
        purpose: 'invite',
        meta: meta ?? null,
      });
      // The framework JWT carries only { user_id, email, roles }, so
      // name attribution is best-effort: names when a richer req.user
      // is present, otherwise the inviter's email.
      const inviter =
        [req.user && req.user.first_name, req.user && req.user.last_name]
          .filter(Boolean)
          .join(' ') ||
        (req.user && req.user.email) ||
        null;
      await state.sendMail({
        to: String(email).toLowerCase().trim(),
        subject: `You've been invited to ${state.appName}`,
        text:
          `${name ? `${name}, you` : 'You'}'ve been invited` +
          `${inviter ? ` by ${inviter}` : ''} to join ${state.appName}.\n` +
          `${note ? `\n"${String(note).slice(0, 500)}"\n` : ''}` +
          `\nJoin within ${config.ttlMinutes} minutes:\n\n` +
          `${buildVerifyUrl(config.url, raw)}`,
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST <path>/verify  { token }
   *
   * Atomic single-use claim: the findOneAndUpdate predicate (unused +
   * unexpired) means two concurrent verifies of the same token can't
   * both mint a session — the loser sees no match. Expiry is enforced
   * here at read time; the TTL index is only a janitor.
   */
  async function verify(req, res, next) {
    try {
      const { token } = req.body || {};
      if (!token || typeof token !== 'string') {
        throw new state.errors.ValidationError('token is required');
      }
      const record = await state.MagicLinkToken.findOneAndUpdate(
        {
          tokenHash: sha256(token),
          usedAt: null,
          expiresAt: { $gt: new Date() },
        },
        { $set: { usedAt: new Date() } },
        { new: false }
      );
      if (!record) {
        throw new state.errors.UnauthorizedError('Invalid or expired link');
      }
      const user = await state.User.findById(record.userId);
      if (!user) {
        throw new state.errors.UnauthorizedError('Account no longer exists');
      }
      const tokens = await state.issueTokenPair(user, req);
      res.status(200).json({
        ...tokens,
        user: serialiseUser(user),
        purpose: record.purpose,
        meta: record.meta ?? null,
      });
    } catch (err) {
      next(err);
    }
  }

  return { request, invite, verify, issueMagicLink, findOrCreateUser };
}

module.exports = {
  buildMagicLinkHandlers,
  buildVerifyUrl,
  looksLikeEmail,
  sha256,
  generateToken,
};
