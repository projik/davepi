const logger = require('./logger');

const isProduction = () => process.env.NODE_ENV === 'production';

let cachedTransporter = null;
let transporterAttempted = false;

const getTransporter = () => {
  if (transporterAttempted) return cachedTransporter;
  transporterAttempted = true;
  if (!process.env.SMTP_HOST) return null;

  const nodemailer = require('nodemailer');
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          }
        : undefined,
  });
  return cachedTransporter;
};

/**
 * Send mail.
 *
 * Routing matrix:
 * - NODE_ENV !== 'production': always log the full email payload to the
 *   structured logger and never send. This keeps the dev URL visible
 *   even if a developer points SMTP_HOST at a local relay by accident.
 * - NODE_ENV === 'production' + SMTP_HOST set: send via nodemailer.
 * - NODE_ENV === 'production' + SMTP_HOST unset: log only the headers
 *   ({to, subject}). The body is *not* logged because it can contain
 *   secrets — e.g., a password-reset URL embeds a live, single-use
 *   token, and dropping that into prod logs is a credential leak.
 */
async function sendMail({ to, subject, text, html }) {
  if (!isProduction()) {
    logger.info(
      { to, subject, text, html },
      'mailer: non-production — logging instead of sending'
    );
    return;
  }

  const transporter = getTransporter();
  if (!transporter) {
    // Body deliberately omitted — see comment above.
    logger.error(
      { to, subject },
      'mailer: SMTP not configured in production; email NOT sent'
    );
    return;
  }

  const from = process.env.SMTP_FROM || 'no-reply@example.com';
  await transporter.sendMail({ from, to, subject, text, html });
}

// exported for tests
const __resetTransporter = () => {
  cachedTransporter = null;
  transporterAttempted = false;
};

module.exports = { sendMail, __resetTransporter };
