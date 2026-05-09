const crypto = require('crypto');
const pinoHttp = require('pino-http');
const logger = require('../utils/logger');

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

const sanitizeRequestId = (raw) => {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  return VALID_REQUEST_ID.test(value) ? value : null;
};

module.exports = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const id = sanitizeRequestId(req.headers['x-request-id']) || crypto.randomUUID();
    try {
      res.setHeader('x-request-id', id);
    } catch (_e) {
      // setHeader can throw on header-name/value validation failures in
      // edge cases; fall through with the id we have for log correlation.
    }
    return id;
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
