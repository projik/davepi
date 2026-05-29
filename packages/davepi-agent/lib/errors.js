'use strict';

/**
 * Local typed errors. Same shape as the framework's utils/errors.js
 * (status + code + message) but kept in this package so a consumer
 * who depends on @davepi/agent without davepi installed gets a
 * working error pipeline. The HTTP errorHandler middleware in
 * channels/http.js maps these to response status + body.
 */

class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

class UnlinkedError extends AppError {
  constructor(linkUrl) {
    super('Account is not linked', 401, 'UNLINKED');
    this.name = 'UnlinkedError';
    this.linkUrl = linkUrl;
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  UnlinkedError,
};
