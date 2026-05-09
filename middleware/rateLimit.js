const rateLimit = require('express-rate-limit');

const isTest = () => process.env.NODE_ENV === 'test';

const skipDuringTests = () => isTest();

const buildAuthLimiter = (overrides = {}) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipDuringTests,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many attempts, please try again later.',
      },
    },
    ...overrides,
  });

const buildApiLimiter = (overrides = {}) =>
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipDuringTests,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later.',
      },
    },
    ...overrides,
  });

module.exports = {
  authLimiter: buildAuthLimiter(),
  apiLimiter: buildApiLimiter(),
  buildAuthLimiter,
  buildApiLimiter,
};
