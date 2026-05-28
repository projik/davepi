'use strict';

const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

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
  name: 'davepi-agent',
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'headers.authorization',
      'headers.Authorization',
      '*.bearer',
      '*.password',
      '*.token',
      '*.refresh_token',
      '*.access_token',
    ],
    censor: '[REDACTED]',
  },
  transport,
});

module.exports = logger;
