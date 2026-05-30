/**
 * Schema-level lifecycle hooks.
 *
 * A schema can declare a `hooks` block with any of:
 *
 *   hooks: {
 *     beforeCreate: async ({ input, user, req, schema }) => input,
 *     afterCreate:  async ({ record, user, req, schema }) => {},
 *     beforeUpdate: async ({ input, current, user, req, schema }) => input,
 *     afterUpdate:  async ({ record, previous, user, req, schema }) => {},
 *     beforeDelete: async ({ current, user, req, schema }) => {},
 *     afterDelete:  async ({ record, user, req, schema }) => {},
 *   }
 *
 * Posture:
 *   - `before*` hooks run synchronously to the request. Returning a value
 *     from beforeCreate / beforeUpdate replaces the input that gets
 *     persisted; returning `undefined` keeps the input as-is. Throwing
 *     rejects the operation (the error reaches `errorHandler` like any
 *     other thrown error — use the typed errors from `utils/errors.js`
 *     for predictable HTTP status codes).
 *   - `after*` hooks run after persistence and are best-effort: a thrown
 *     error is logged but never fails the response. This mirrors the
 *     state-machine `onEnter` posture and the audit posture so a flaky
 *     side effect can't roll back a committed mutation.
 *
 * Surface coverage:
 *   - REST: POST /api/{v}/{path}, PUT /api/{v}/{path}/:id, DELETE /api/{v}/{path}/:id
 *   - GraphQL: {path}CreateOne, {path}UpdateById, {path}RemoveById
 *   - MCP: delete_{path} runs beforeDelete / afterDelete. create_{path}
 *     and update_{path} deliberately do NOT run hooks (the agent writes
 *     its own memory/profiles over MCP and relies on that — see the
 *     agentMemory schema), but delete is a governance gate: a schema like
 *     `skill` or `agentPersona` blocks agent-authored deletes through
 *     beforeDelete, and delete has no field-level ACL to fall back on, so
 *     skipping the hook on MCP would be a silent bypass.
 *
 * Bulk paths (PUT /api/{v}/{path}, GraphQL createMany / updateMany /
 * removeMany) intentionally do NOT invoke per-record hooks — running
 * declarative hooks across a server-side filter would multiply work in
 * surprising ways. Plugins that need to react to bulk writes should
 * subscribe to the record event bus from `utils/events.js` instead.
 */

const logger = require('./logger');

const HOOK_NAMES = [
  'beforeCreate',
  'afterCreate',
  'beforeUpdate',
  'afterUpdate',
  'beforeDelete',
  'afterDelete',
];

const getHook = (schema, name) => {
  const hooks = schema && schema.hooks;
  const fn = hooks && hooks[name];
  return typeof fn === 'function' ? fn : null;
};

/**
 * Run a `before*` hook. The hook can mutate the supplied input or
 * return a replacement. A returned object replaces the input; a
 * returned `undefined` keeps the input unchanged. Throws bubble up.
 */
async function runBeforeHook(schema, name, ctx) {
  const fn = getHook(schema, name);
  if (!fn) return ctx.input;
  const result = await fn({ ...ctx, schema });
  if (result === undefined) return ctx.input;
  return result;
}

/**
 * Run an `after*` hook. Always best-effort: a thrown error is logged
 * via the supplied logger (or the framework's default pino logger
 * when none is passed) and never propagates. Returning a value is
 * meaningless — the persisted record is whatever the route already
 * wrote.
 */
async function runAfterHook(schema, name, ctx, log) {
  const fn = getHook(schema, name);
  if (!fn) return;
  try {
    await fn({ ...ctx, schema });
  } catch (err) {
    // Fall back to the framework logger when the caller didn't pass
    // one — keeps redaction, transports, and silenced-in-test
    // posture consistent with the rest of the codebase. `console.*`
    // would bypass all of that.
    const sink = log && typeof log.warn === 'function' ? log : logger;
    sink.warn(
      { err, hook: name, schema: schema && schema.path },
      'after-hook threw; mutation already committed'
    );
  }
}

module.exports = {
  HOOK_NAMES,
  getHook,
  runBeforeHook,
  runAfterHook,
};
