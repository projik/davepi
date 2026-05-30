'use strict';

/**
 * A safe no-op logger used only as a last-resort default.
 *
 * In production the framework always injects its pino logger — via
 * `setup({ log })` for the plugin and `ctx.log` for the queue worker —
 * so these methods are never actually the ones that run. We default to
 * this rather than `console` so a missing logger can never bypass the
 * framework's redaction/formatting or leak to stdout (CLAUDE.md: never
 * use `console.*` in application code).
 */
const NOOP_LOG = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return NOOP_LOG;
  },
};

module.exports = { NOOP_LOG };
