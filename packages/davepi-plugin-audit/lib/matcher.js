'use strict';

/**
 * Resource allow/deny matcher.
 *
 * `include` is an allowlist of resource names ('order', 'invoice'); an
 * empty / unset list means "all resources are eligible". `exclude` is
 * a denylist that wins on a conflict — if `audit` is in `exclude`, the
 * plugin never writes a row for it, even when also in `include`. That
 * ordering is documented in the issue and lets an operator turn off
 * audit for a specific high-cardinality resource without rebuilding
 * their allowlist.
 *
 * The plugin's own `audit` resource is filtered out by the caller
 * before this matcher runs (any row produced from an `audit.*` event
 * would create a feedback loop), so we don't special-case it here.
 */
function shouldAuditResource(resource, { include, exclude }) {
  if (!resource) return false;
  if (Array.isArray(exclude) && exclude.length && exclude.includes(resource)) {
    return false;
  }
  if (Array.isArray(include) && include.length) {
    return include.includes(resource);
  }
  return true;
}

/**
 * Parse a record-event `type` into `{ resource, action }`. Events are
 * shaped as `<resource>.<verb>` where verb is one of
 * `created` / `updated` / `deleted` / `transitioned`. We split on the
 * LAST `.` so a resource name with a `.` in it (none today, but the
 * framework doesn't forbid it) still routes correctly.
 *
 * `action` is normalised to the past-tense form the audit row stores
 * (matching the spec). Unknown verbs fall through as-is so the row
 * isn't silently dropped — operators can investigate via the audit
 * row's stored action.
 */
function parseEventType(type) {
  if (typeof type !== 'string' || !type.length) return null;
  const lastDot = type.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === type.length - 1) return null;
  return {
    resource: type.slice(0, lastDot),
    action: type.slice(lastDot + 1),
  };
}

function parseList(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { shouldAuditResource, parseEventType, parseList };
