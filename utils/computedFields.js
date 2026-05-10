/**
 * Computed / virtual fields. A schema field with a `computed` function
 * is read-only — never stored in Mongo, never written from the wire,
 * always derived at response time.
 *
 * Surfaces:
 *   - REST GET (single + list): applyComputed runs after the fetch
 *     and decoration passes, before ACL projection.
 *   - GraphQL: each computed field is added to the type as a resolver
 *     so it's resolved lazily — clients only pay the cost when they
 *     ask for the field.
 *   - Swagger / `GET /api/v1/{path}-schema`: each computed field
 *     surfaces with `readOnly: true`.
 *   - filterWritable: client-supplied values for computed field names
 *     are dropped on POST / PUT (writes pretend the field doesn't
 *     exist on input).
 *
 * The function signature is `(record, ctx) => value | Promise<value>`.
 * `ctx` provides:
 *   - ctx.user      — the authenticated user (`{ user_id, roles, ... }`)
 *   - ctx.now()     — overridable date source (defaults to new Date())
 *   - ctx.count()   — tenant-scoped count against another schema
 *   - ctx.find()    — tenant-scoped find against another schema
 *   - ctx.req       — the underlying request when REST applies (locale,
 *                      reqId, etc.); undefined under GraphQL
 *
 * Async resolution is parallelised across records AND across
 * computeds, so a list of N records each with K computed fields
 * fans out N×K promises, not N×K sequential awaits.
 */

const isComputedField = (f) => Boolean(f && typeof f.computed === 'function');

const computedFieldsOf = (schema) =>
  Array.isArray(schema && schema.fields)
    ? schema.fields.filter(isComputedField)
    : [];

/**
 * Build the `ctx` argument passed to every computed function.
 * `getResource(path)` is the same callback shape used by the
 * relations engine — keeps cross-resource lookups tenant-scoped
 * without leaking schemaLoader internals into computed bodies.
 */
function buildComputedContext({ user, getResource, req }) {
  const tenantId = user && user.user_id;
  const tenantFilter = (filter) => ({
    ...(filter && typeof filter === 'object' ? filter : {}),
    userId: tenantId,
    deletedAt: null,
  });
  return {
    user,
    req,
    now: () => new Date(),
    async count(path, filter = {}) {
      const target = getResource && getResource(path);
      if (!target || !target.model) return 0;
      return target.model.find(tenantFilter(filter)).countDocuments();
    },
    async find(path, filter = {}, opts = {}) {
      const target = getResource && getResource(path);
      if (!target || !target.model) return [];
      const limit = Math.min(opts.limit || 100, 500);
      return target.model.find(tenantFilter(filter)).limit(limit).lean();
    },
  };
}

/**
 * Mutate every record in `records` in place to attach the computed
 * values declared on `schema.fields`. No-op when the schema declares
 * no computeds, or the record set is empty.
 */
async function applyComputed(records, schema, ctx) {
  if (!Array.isArray(records) || records.length === 0) return records;
  const computeds = computedFieldsOf(schema);
  if (!computeds.length) return records;

  const tasks = [];
  for (const record of records) {
    for (const f of computeds) {
      tasks.push(
        Promise.resolve()
          .then(() => f.computed(record, ctx))
          .then((value) => {
            record[f.name] = value;
          })
          .catch((err) => {
            // A throwing computed field shouldn't break the whole
            // response — surface null and let the client see the
            // shape it expected. Errors bubble through ctx.req.log
            // so operators can find them.
            const log = ctx && ctx.req && ctx.req.log;
            if (log && log.warn) {
              log.warn(
                { err, field: f.name, schema: schema.path },
                'computed field threw; returning null'
              );
            }
            record[f.name] = null;
          })
      );
    }
  }
  await Promise.all(tasks);
  return records;
}

module.exports = {
  isComputedField,
  computedFieldsOf,
  buildComputedContext,
  applyComputed,
};
