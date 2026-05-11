const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// pino-pretty is a regular dependency, but defend against the case
// where a consumer trims it (e.g. `npm prune --production` or a
// custom install profile). If it's missing, fall back to plain JSON
// output rather than crashing at boot.
let transport;
if (!isProduction && !isTest) {
  try {
    require.resolve('pino-pretty');
    transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    };
  } catch {
    /* pino-pretty not installed — JSON output */
  }
}

const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.encryptedPassword',
    ],
    censor: '[REDACTED]',
  },
  transport,
});

module.exports = logger;
