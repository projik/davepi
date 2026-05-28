'use strict';

/**
 * TOTP-based 2FA. Three handlers:
 *
 *   POST /auth/2fa/enroll    (authenticated) → generate secret + backup codes
 *   POST /auth/2fa/verify    (authenticated) → confirm pending → enabled
 *   POST /auth/2fa/challenge (anonymous)     → mint JWT given valid code
 *
 * Secret storage: AES-256-GCM, key derived from `TOKEN_KEY` via SHA-256
 * (matches the framework's symmetric-secret posture without pulling
 * in a fresh KDF). The IV is 12 random bytes per encrypt, the auth
 * tag travels in the wire format `<iv-hex>.<tag-hex>.<ciphertext-hex>`.
 *
 * Backup codes: eight base32 12-char codes, shown to the user once at
 * enrollment, stored as sha256 hashes. A successful backup-code use
 * removes that hash so the code is one-shot.
 *
 * Why `totpPendingEnc` separate from `totpSecretEnc`: an attacker who
 * MITMs the enroll response but doesn't have the user's 2FA app can't
 * complete the verify step. Only once verify succeeds does the
 * pending secret become the live one and `twofaEnabled` flip true.
 */

const crypto = require('crypto');

function deriveKey(tokenKey) {
  if (!tokenKey) {
    throw new Error('davepi-plugin-twilio: TOKEN_KEY is required for 2FA secret encryption');
  }
  return crypto.createHash('sha256').update(String(tokenKey)).digest();
}

function encrypt(plaintext, tokenKey) {
  const key = deriveKey(tokenKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`;
}

function decrypt(wire, tokenKey) {
  const key = deriveKey(tokenKey);
  const parts = String(wire || '').split('.');
  if (parts.length !== 3) throw new Error('davepi-plugin-twilio: malformed ciphertext');
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString('utf8');
}

function generateBackupCode() {
  // Base32 alphabet (Crockford-ish without I/L/O/U to avoid OCR mixups
  // when a user reads a printed sheet to their phone).
  const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const buf = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length];
  }
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function buildTotpHandlers({ config, state, verifyTotpForUser }) {
  function err(name, fallbackStatus, fallbackCode) {
    return (msg) => {
      const E = state.errors && state.errors[name];
      if (E) return new E(msg);
      return Object.assign(new Error(msg), { status: fallbackStatus, code: fallbackCode });
    };
  }
  const ValidationError   = err('ValidationError', 400, 'VALIDATION');
  const UnauthorizedError = err('UnauthorizedError', 401, 'UNAUTHORIZED');
  const NotFoundError     = err('NotFoundError', 404, 'NOT_FOUND');

  const enroll = asyncRoute(async (req, res) => {
    if (!req.user || !req.user.user_id) throw UnauthorizedError('authentication required');
    if (!state.totp) throw ValidationError('TOTP not available (otplib not installed)');
    if (!state.User) throw NotFoundError('User');

    const secret = state.totp.generateSecret();
    const totpPendingEnc = encrypt(secret, state.config.tokenKey);

    const backupCodes = Array.from({ length: 8 }, () => generateBackupCode());
    const backupCodeHashes = backupCodes.map(sha256);

    // strict:false because consumer-owned User model may not declare
    // any of these fields.
    await state.User.findByIdAndUpdate(
      req.user.user_id,
      { $set: { totpPendingEnc, backupCodeHashes } },
      { strict: false, new: true }
    );

    const issuer = state.appName || 'dAvePi';
    const label = (req.user.email || req.user.user_id);
    const otpauthUrl = typeof state.totp.keyuri === 'function'
      ? state.totp.keyuri(label, issuer, secret)
      : `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

    res.status(200).json({ otpauthUrl, secret, backupCodes });
  });

  const verify = asyncRoute(async (req, res) => {
    if (!req.user || !req.user.user_id) throw UnauthorizedError('authentication required');
    const code = req.body && req.body.code;
    if (!code) throw ValidationError('code is required');
    if (!state.User) throw NotFoundError('User');
    const user = await state.User.findById(req.user.user_id);
    if (!user || !user.totpPendingEnc) throw ValidationError('no pending TOTP enrollment');

    const secret = decrypt(user.totpPendingEnc, state.config.tokenKey);
    if (!state.totp || !state.totp.verify({ token: String(code), secret })) {
      throw UnauthorizedError('invalid code');
    }

    await state.User.findByIdAndUpdate(
      user._id,
      {
        $set: { totpSecretEnc: user.totpPendingEnc, twofaEnabled: true },
        $unset: { totpPendingEnc: 1 },
      },
      { strict: false, new: true }
    );

    res.status(200).json({ ok: true });
  });

  // /auth/2fa/challenge: given an already-known user (by id or phone)
  // and a valid TOTP or backup code, issue a fresh JWT. Used after a
  // password login flow that's gated by twofaEnabled.
  const challenge = asyncRoute(async (req, res) => {
    const { userId, phone, code } = (req.body || {});
    if (!code) throw ValidationError('code is required');
    if (!userId && !phone) throw ValidationError('userId or phone is required');
    if (!state.User) throw NotFoundError('User');

    let user = null;
    if (userId) user = await state.User.findById(userId);
    if (!user && phone) user = await state.User.findOne({ phone });
    if (!user || !user.twofaEnabled) throw UnauthorizedError('2FA not enabled');

    const ok = await verifyTotpForUser(user._id, code);
    if (!ok) throw UnauthorizedError('invalid code');

    if (!state.issueTokenPair) throw UnauthorizedError('token issuance not available');
    const { accessToken, refreshToken } = await state.issueTokenPair(user, req);
    res.status(200).json({ accessToken, refreshToken, user: { _id: user._id } });
  });

  return { enroll, verify, challenge };
}

module.exports = {
  buildTotpHandlers,
  encrypt,
  decrypt,
  generateBackupCode,
  sha256,
};
