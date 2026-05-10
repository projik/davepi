class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL') {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.isOperational = true;
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400, 'VALIDATION');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

class MethodNotAllowedError extends AppError {
  constructor(message = 'Method not allowed') {
    super(message, 405, 'METHOD_NOT_ALLOWED');
  }
}

/**
 * Idempotency-Key was reused with a different request body. The
 * caller is asking the server to do two different things under the
 * same retry key, which we refuse — see https://docs.davepi.dev/features/idempotency/.
 */
class IdempotencyConflictError extends AppError {
  constructor(message = 'Idempotency-Key was reused with a different request body') {
    super(message, 409, 'IDEMPOTENCY_CONFLICT');
  }
}

/**
 * A previous request with the same Idempotency-Key is still
 * executing. Returned when two concurrent calls race the same key
 * and the second one arrives before the first has finished. The
 * caller should retry shortly — by then the first call's response
 * will be cached and replayed.
 */
class IdempotencyInProgressError extends AppError {
  constructor(message = 'A request with this Idempotency-Key is still in progress; retry shortly') {
    super(message, 409, 'IDEMPOTENCY_IN_PROGRESS');
  }
}

/**
 * A state-machine-controlled field was set to a value that's not
 * a declared transition from its current value. Carries
 * `current` / `attempted` / `allowed` in `details` so a client can
 * render actionable next-steps without re-parsing the schema.
 */
class InvalidTransitionError extends AppError {
  constructor(message = 'Invalid state transition', details = {}) {
    super(message, 400, 'INVALID_TRANSITION');
    this.details = details;
  }
}

module.exports = {
  AppError,
  NotFoundError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  MethodNotAllowedError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  InvalidTransitionError,
};
