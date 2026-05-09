const mongoose = require('mongoose');

const FORBIDDEN_STAGES = new Set([
  '$out',
  '$merge',
  '$lookup',
  '$graphLookup',
  '$unionWith',
  '$function',
  '$accumulator',
]);

const ALLOWED_PARAM_TYPES = ['string', 'number', 'boolean', 'date', 'objectId'];

const DEFAULT_RESULT_LIMIT = 10000;

class AggregationParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AggregationParamError';
  }
}

class AggregationSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AggregationSafetyError';
  }
}

/**
 * Validate the param map declared on the aggregation against the
 * caller's request, type-cast each value, and return a flat
 * `{ paramName: castedValue }` object that can be substituted into
 * the pipeline.
 */
function validateAndCastParams(spec, raw) {
  if (!spec || typeof spec !== 'object') return {};
  const out = {};
  for (const [name, def] of Object.entries(spec)) {
    const t = def && def.type;
    if (!ALLOWED_PARAM_TYPES.includes(t)) {
      throw new AggregationParamError(
        `param ${name}: unsupported type '${t}' (allowed: ${ALLOWED_PARAM_TYPES.join(', ')})`
      );
    }
    const value = raw && Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : undefined;
    if (value === undefined || value === '') {
      if (def.required) {
        throw new AggregationParamError(`param ${name} is required`);
      }
      continue;
    }
    out[name] = castValue(name, value, t);
  }
  return out;
}

function castValue(name, value, type) {
  switch (type) {
    case 'string':
      return String(value);
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new AggregationParamError(`param ${name}: not a number (${value})`);
      }
      return n;
    }
    case 'boolean':
      if (value === true || value === 'true' || value === '1' || value === 1) return true;
      if (value === false || value === 'false' || value === '0' || value === 0) return false;
      throw new AggregationParamError(`param ${name}: not a boolean (${value})`);
    case 'date': {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        throw new AggregationParamError(`param ${name}: not a date (${value})`);
      }
      return d;
    }
    case 'objectId':
      if (!mongoose.Types.ObjectId.isValid(value)) {
        throw new AggregationParamError(`param ${name}: not an ObjectId (${value})`);
      }
      return new mongoose.Types.ObjectId(value);
    default:
      // unreachable — the type check above narrows the set.
      return value;
  }
}

/**
 * Walk the pipeline, replacing every string occurrence of `:name`
 * inside any value with the corresponding cast parameter. Non-string
 * leaves pass through unchanged so existing operators that produce
 * dates / numbers / etc. survive the substitution.
 */
function substitute(pipeline, params) {
  if (!params || Object.keys(params).length === 0) return clone(pipeline);
  return walk(pipeline, params);
}

function walk(value, params) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.startsWith(':') && Object.prototype.hasOwnProperty.call(params, value.slice(1))) {
      return params[value.slice(1)];
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, params));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walk(v, params);
    }
    return out;
  }
  return value;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Inspect a pipeline for forbidden operators (cross-collection joins,
 * data-write stages, and arbitrary-code constructs). Used as a
 * defense-in-depth check on every request.
 *
 * The walk is recursive — a top-level-only scan would silently allow
 * forbidden operators that appear nested inside another stage's
 * body, e.g. `$lookup` inside a `$facet` sub-pipeline, or `$function`
 * inside a `$project` expression. Any key in the pipeline tree that
 * matches `FORBIDDEN_STAGES` triggers rejection unless the
 * declaration opted in with `unsafe: true`.
 */
function assertSafePipeline(pipeline, { unsafe } = {}) {
  if (unsafe) return;
  const visit = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_STAGES.has(k)) {
        throw new AggregationSafetyError(
          `Aggregation operator ${k} is forbidden. Pass unsafe: true on the aggregation declaration to opt in.`
        );
      }
      visit(v);
    }
  };
  visit(pipeline);
}

/**
 * Build the final pipeline that hits Mongo:
 *   1. $match { userId } prepended for tenant isolation.
 *   2. The user's pipeline with parameters substituted.
 *   3. $limit appended if the pipeline doesn't already include one
 *      (so a runaway aggregation can't return millions of rows).
 *
 * Tenant isolation is non-bypassable: the prepended $match runs
 * before any user-supplied stage, so even an `unsafe: true`
 * aggregation can't produce cross-tenant results.
 */
function buildPipeline(aggregation, { userId, params }) {
  const safeUserId = String(userId);
  const userPipeline = substitute(aggregation.pipeline || [], params || {});
  assertSafePipeline(userPipeline, { unsafe: !!aggregation.unsafe });
  const hasLimit = userPipeline.some((s) => s && Object.prototype.hasOwnProperty.call(s, '$limit'));
  const limitStage = hasLimit
    ? []
    : [{ $limit: aggregation.maxResults || DEFAULT_RESULT_LIMIT }];
  return [{ $match: { userId: safeUserId } }, ...userPipeline, ...limitStage];
}

module.exports = {
  validateAndCastParams,
  substitute,
  assertSafePipeline,
  buildPipeline,
  AggregationParamError,
  AggregationSafetyError,
  FORBIDDEN_STAGES,
  DEFAULT_RESULT_LIMIT,
  ALLOWED_PARAM_TYPES,
};
