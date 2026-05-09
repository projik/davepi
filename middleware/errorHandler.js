const mongoose = require('mongoose');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

const isProduction = () => process.env.NODE_ENV === 'production';

const formatMongooseValidation = (err) =>
  Object.values(err.errors)
    .map((e) => e.message)
    .join('; ');

const formatDuplicateKey = (err) => {
  const fields = Object.keys(err.keyValue || {});
  return fields.length
    ? `Duplicate value for: ${fields.join(', ')}`
    : 'Duplicate key';
};

module.exports = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  let status = err.status || err.statusCode || 500;
  let code = err.code || 'INTERNAL';
  let message = err.message || 'Internal server error';

  if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    code = 'VALIDATION';
    message = formatMongooseValidation(err);
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'INVALID_ID';
    message = `Invalid ${err.path}`;
  } else if (err.code === 11000) {
    status = 409;
    code = 'DUPLICATE';
    message = formatDuplicateKey(err);
  } else if (!(err instanceof AppError)) {
    code = 'INTERNAL';
    if (isProduction()) message = 'Internal server error';
  }

  if (status >= 500) {
    const log = req.log || logger;
    log.error({ err, code }, message);
  }

  res.status(status).json({ error: { code, message } });
};
