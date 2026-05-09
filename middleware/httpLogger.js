const crypto = require('crypto');
const pinoHttp = require('pino-http');
const logger = require('../utils/logger');

module.exports = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = incoming || crypto.randomUUID();
    res.setHeader('x-request-id', id);
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
