const logger = require('./logger');

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
 * Send mail via SMTP if configured; otherwise log the would-be email.
 *
 * The dev fallback is deliberate: local + CI environments shouldn't need
 * an SMTP server, but the developer still wants to see the reset URL. In
 * production with no SMTP_HOST, this falls back silently — callers should
 * monitor for the "no SMTP configured" warning at boot.
 */
async function sendMail({ to, subject, text, html }) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || 'no-reply@example.com';

  if (!transporter) {
    logger.info(
      { to, subject, text, html },
      'mailer: SMTP_HOST not set — logging email instead of sending'
    );
    return;
  }

  await transporter.sendMail({ from, to, subject, text, html });
}

// exported for tests
const __resetTransporter = () => {
  cachedTransporter = null;
  transporterAttempted = false;
};

module.exports = { sendMail, __resetTransporter };
