const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const transport = !isProduction && !isTest
  ? {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    }
  : undefined;

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
