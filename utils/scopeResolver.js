const { AuthenticationError, ForbiddenError } = require('apollo-server-express');
const {
  projectByAcl,
  filterWritable,
  bypassUserScopeForList,
  bypassUserScopeForDelete,
  canReadField,
  stampTenantFields,
  stripTenantFields,
  getRoleScopeFilter,
  applyRoleScopeFilter,
} = require('./acl');
const { emitRecordEvent } = require('./events');
const { runBeforeHook, runAfterHook } = require('./hooks');
const logger = require('./logger');

const STAMPED_FIELDS = ['userId', 'accountId'];

const refuseClientWrite = (user) => {
  if (user && user.isClient) {
    throw new ForbiddenError('Client-authenticated requests are read-only');
  }
};

const requireUser = (rp) => {
  const userId = rp.context && rp.context.user && rp.context.user.user_id;
  if (!userId) throw new AuthenticationError('Authentication required');
  return userId;
};

const sameId = (a, b) => String(a) === String(b);

/**
 * Evaluate a `schema.acl.scope[role]` filter against an already-
 * fetched record. graphql-compose-mongoose's findById doesn't expose
 * the underlying filter object (the resolver fetches by `_id`
 * directly), so the scope predicate has to be checked in-process
 * after the read. Supports the common shapes documented for
 * `acl.scope`: equality, `$in`, `$nin`, `$ne`, `$exists`, and an
 * `$and` envelope produced by `applyRoleScopeFilter` when multiple
 * roles each declare a scope. Anything more exotic (regex,
 * geospatial, etc.) is reserved for REST list queries where the
 * predicate lands directly on the Mongo driver.
 */
const matchesScopeFragment = (record, filter) => {
  if (!filter || typeof filter !== 'object') return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$and') {
      if (!Array.isArray(expected)) continue;
      if (!expected.every((f) => matchesScopeFragment(record, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!Array.isArray(expected)) continue;
      if (!expected.some((f) => matchesScopeFragment(record, f))) return false;
      continue;
    }
    const actual = record ? record[key] : undefined;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) {
        if (!Array.isArray(expected.$in) || !expected.$in.some((v) => sameId(v, actual))) return false;
        continue;
      }
      if ('$nin' in expected) {
        if (Array.isArray(expected.$nin) && expected.$nin.some((v) => sameId(v, actual))) return false;
        continue;
      }
      if ('$ne' in expected) {
        if (sameId(expected.$ne, actual)) return false;
        continue;
      }
      if ('$exists' in expected) {
        const present = actual !== undefined && actual !== null;
        if (Boolean(expected.$exists) !== present) return false;
        continue;
      }
      // Unsupported operator — fail closed.
      return false;
    }
    if (!sameId(expected, actual)) return false;
  }
  return true;
};

const matchesRoleScope = (record, schema, user) => {
  const scope = getRoleScopeFilter(schema, user);
  if (!scope) return true;
  return matchesScopeFragment(record, scope);
};

const stampedValues = (userId) => ({ userId, accountId: userId });

const stripFromInput = (resolver, argName) => {
  try {
    const itc = resolver.getArgITC(argName);
    STAMPED_FIELDS.forEach((f) => {
      if (itc.hasField(f)) itc.removeField(f);
    });
  } catch (e) {
    // arg or input type doesn't exist for this resolver; skip
  }
};

const userFromContext = (rp) =>
  (rp.context && rp.context.user) || null;

/**
 * Map the resolver's return value onto one or more `record` events.
 * graphql-compose-mongoose returns:
 *   - createOne / updateById / removeById → `{ record }`
 *     (`recordId` is a child resolver computed from `record._id`)
 *   - createMany → `{ records }`
 *   - updateMany / removeMany → `{ numAffected }`
 *
 * The emitted `record` is always projected through the actor's ACL.
 * Webhook delivery is a side channel; ACL-restricted fields visible
 * via the API response must not leak through it either.
 */
const emitForMutation = (schema, action, user, result) => {
  if (!schema || !result) return;
  const userId = user && user.user_id;
  const eventType = `${schema.path}.${action}`;
  if (result.record) {
    const plain = toPlain(result.record);
    const projected = projectByAcl(plain, schema, user);
    emitRecordEvent({
      type: eventType,
      version: schema.version,
      userId,
      recordId: plain && plain._id ? String(plain._id) : undefined,
      record: projected,
    });
    return;
  }
  if (Array.isArray(result.records)) {
    result.records.forEach((rec) => {
      const plain = rec ? toPlain(rec) : null;
      const projected = plain ? projectByAcl(plain, schema, user) : null;
      emitRecordEvent({
        type: eventType,
        version: schema.version,
        userId,
        recordId: plain && plain._id ? String(plain._id) : undefined,
        record: projected,
      });
    });
    return;
  }
  if (typeof result.numAffected === 'number') {
    emitRecordEvent({
      type: eventType,
      version: schema.version,
      userId,
      numAffected: result.numAffected,
    });
  }
};

const toPlain = (doc) => {
  if (!doc) return doc;
  if (typeof doc.toObject === 'function') return doc.toObject();
  if (typeof doc.toJSON === 'function') return doc.toJSON();
  return { ...doc };
};

/**
 * Strip ACL'd fields from a resolver result. Handles every shape
 * graphql-compose-mongoose hands back: a single record, an array of
 * records, or a mutation envelope (`{ record, recordId, ... }`,
 * `{ records, recordIds, ... }`, `{ items, ... }`,
 * `{ edges: [{ node }], ... }`).
 */
const projectResult = (result, schema, user) => {
  if (!result || !schema) return result;
  // Primitive results (e.g., the integer returned by `count`) can't
  // be projected — and `{ ...5 }` produces `{}` which breaks GraphQL
  // serialization of Int return types. Pass them through unchanged.
  if (typeof result !== 'object') return result;
  if (Array.isArray(result)) {
    return result.map((r) => projectByAcl(toPlain(r), schema, user));
  }
  // Single record: it has _id but no envelope keys.
  if (result._id !== undefined && !result.record && !result.records) {
    return projectByAcl(toPlain(result), schema, user);
  }
  const out = { ...result };
  if (out.record) out.record = projectByAcl(toPlain(out.record), schema, user);
  if (Array.isArray(out.records)) {
    out.records = out.records.map((r) => projectByAcl(toPlain(r), schema, user));
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((r) => projectByAcl(toPlain(r), schema, user));
  }
  if (Array.isArray(out.edges)) {
    out.edges = out.edges.map((e) => ({
      ...e,
      node: e.node ? projectByAcl(toPlain(e.node), schema, user) : e.node,
    }));
  }
  return out;
};

/**
 * For filter-based queries / write-mutations: inject userId into the
 * filter (unless the schema's acl.list bypass applies for reads, or
 * acl.delete for delete-class mutations); apply field-level write ACL
 * to the record arg; project ACL'd fields out of the result.
 *
 * `kind` controls the bypass slot: 'read' uses acl.list,
 * 'delete' uses acl.delete, anything else (default, 'write') stays
 * strictly owner-bound.
 */
const wrapFilter = (resolver, { schema, action, kind = 'write' } = {}) => {
  stripFromInput(resolver, 'record');
  return resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const user = userFromContext(rp);

    // Refuse client-authed callers on any mutation surface this
    // wrapper covers (updateMany/removeMany). Read-class kinds are
    // allowed through.
    if (kind !== 'read') refuseClientWrite(user);

    const bypass =
      (kind === 'read' && bypassUserScopeForList(schema, user)) ||
      (kind === 'delete' && bypassUserScopeForDelete(schema, user));

    rp.args.filter = {
      ...(rp.args.filter || {}),
      ...(bypass ? {} : { userId }),
    };
    // Server-controlled per-role filter (`schema.acl.scope[role]`).
    // Applied after the caller's own filter so it cannot be widened.
    const scopeFilter = getRoleScopeFilter(schema, user);
    if (scopeFilter) {
      rp.args.filter = applyRoleScopeFilter(rp.args.filter, scopeFilter);
    }

    // Full-text search: opt-in via the `search` arg added in
    // schemaLoader for read resolvers on schemas with searchable
    // fields. Inject $text into the filter so Mongo runs it through
    // the schema-owned text index alongside any other predicates.
    if (rp.args.search) {
      rp.args.filter = {
        ...rp.args.filter,
        $text: { $search: String(rp.args.search) },
      };
      delete rp.args.search;
    }

    if (rp.args.record) {
      // Order matters: ACL-filter the client-provided payload first,
      // THEN overlay the server-stamped fields. Stamping first would
      // expose userId/accountId to filterWritable's strip pass — fine
      // today but a footgun if a schema ever declares acl on those
      // fields. filterWritable protects them by name as well; this is
      // belt-and-suspenders.
      let record = rp.args.record;
      if (action) {
        record = filterWritable(record, schema, user, action);
      }
      rp.args.record = { ...record, ...stampedValues(userId) };
    }

    const result = await next(rp);
    if (action === 'update') emitForMutation(schema, 'updated', user, result);
    else if (kind === 'delete') emitForMutation(schema, 'deleted', user, result);
    return projectResult(result, schema, user);
  });
};

const wrapCreateOne = (resolver, { schema } = {}) => {
  stripFromInput(resolver, 'record');
  return resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const user = userFromContext(rp);
    refuseClientWrite(user);
    const filtered = filterWritable(rp.args.record || {}, schema, user, 'create');
    let stamped = { ...filtered, ...stampedValues(userId) };
    stamped = await runBeforeHook(schema, 'beforeCreate', {
      input: stamped,
      user,
    });
    // Re-stamp post-hook: a beforeCreate hook (including third-party
    // plugin code that returned a rewritten payload) cannot change
    // tenant ownership. The framework stamps userId/accountId from
    // the JWT and that's the only source of truth.
    stampTenantFields(stamped, user);
    rp.args.record = stamped;
    const result = await next(rp);
    emitForMutation(schema, 'created', user, result);
    const projected = projectResult(result, schema, user);
    if (projected && projected.record) {
      await runAfterHook(
        schema,
        'afterCreate',
        { record: projected.record, user },
        logger
      );
    }
    return projected;
  });
};

const wrapCreateMany = (resolver, { schema } = {}) => {
  stripFromInput(resolver, 'records');
  return resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const user = userFromContext(rp);
    refuseClientWrite(user);
    rp.args.records = (rp.args.records || []).map((r) => {
      const filtered = filterWritable(r, schema, user, 'create');
      return { ...filtered, ...stampedValues(userId) };
    });
    const result = await next(rp);
    emitForMutation(schema, 'created', user, result);
    return projectResult(result, schema, user);
  });
};

/**
 * graphql-compose-mongoose projects only the GraphQL fields the client
 * asked for, so callers querying `{ name }` get back a Mongoose doc
 * without `userId` populated. We need userId for the ownership check
 * here, so force it into the projection before delegating.
 */
const ensureProjection = (rp, fields) => {
  rp.projection = { ...(rp.projection || {}) };
  for (const f of fields) rp.projection[f] = true;
};

const wrapFindById = (resolver, { schema } = {}) =>
  resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const user = userFromContext(rp);
    ensureProjection(rp, ['userId']);
    const result = await next(rp);
    if (!result) return null;
    const bypass = bypassUserScopeForList(schema, user);
    if (!bypass && !sameId(result.userId, userId)) return null;
    // Enforce schema.acl.scope[role] post-fetch: a record that
    // doesn't match the role's mandatory filter is treated as
    // not-found to mirror REST behaviour.
    if (!matchesRoleScope(result, schema, user)) return null;
    return projectResult(result, schema, user);
  });

const wrapFindByIds = (resolver, { schema } = {}) =>
  resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const user = userFromContext(rp);
    ensureProjection(rp, ['userId']);
    const results = await next(rp);
    const bypass = bypassUserScopeForList(schema, user);
    const ownerFiltered = bypass
      ? results || []
      : (results || []).filter((r) => sameId(r.userId, userId));
    const scopeFiltered = ownerFiltered.filter((r) =>
      matchesRoleScope(r, schema, user)
    );
    return projectResult(scopeFiltered, schema, user);
  });

/**
 * For *ById mutations (updateById, removeById). Pre-checks ownership
 * unless the schema grants the appropriate bypass: acl.list for
 * updateById (read-class permission), acl.delete for removeById.
 */
const wrapByIdMutation = (Model) => (resolver, { schema, action, kind = 'write' } = {}) => {
  stripFromInput(resolver, 'record');
  return resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const user = userFromContext(rp);
    refuseClientWrite(user);

    const bypass =
      (kind === 'read' && bypassUserScopeForList(schema, user)) ||
      (kind === 'delete' && bypassUserScopeForDelete(schema, user));

    const ownershipQuery = bypass
      ? { _id: rp.args._id }
      : { _id: rp.args._id, userId };

    // Update/delete hooks may want the `current` document. Pull the
    // full lean copy when a relevant hook is declared; otherwise keep
    // the cheap _id-only existence check.
    const isUpdate = action === 'update';
    const isDelete = kind === 'delete';
    const hookName = isUpdate
      ? (isDelete ? null : 'beforeUpdate')
      : (isDelete ? 'beforeDelete' : null);
    const afterHookName = isUpdate ? 'afterUpdate' : (isDelete ? 'afterDelete' : null);
    const needsCurrent = Boolean(
      schema && schema.hooks && (
        (hookName && schema.hooks[hookName]) ||
        (afterHookName && schema.hooks[afterHookName])
      )
    );

    let current = null;
    if (needsCurrent) {
      current = await Model.findOne(ownershipQuery).lean();
      if (!current) throw new ForbiddenError('Record not found');
    } else {
      const exists = await Model.findOne(ownershipQuery).select('_id').lean();
      if (!exists) throw new ForbiddenError('Record not found');
    }

    if (rp.args.record) {
      // Filter first, stamp last — see comment in wrapFilter.
      let record = rp.args.record;
      if (action) record = filterWritable(record, schema, user, action);
      let stamped = { ...record, ...stampedValues(userId) };
      if (hookName && schema && schema.hooks && schema.hooks[hookName]) {
        stamped = await runBeforeHook(schema, hookName, {
          input: stamped,
          current,
          user,
        });
      }
      // Defense in depth: the record being updated is already scoped
      // by ownership (the findOne above filters by `userId`), so
      // including tenant fields in `$set` is at best a no-op and at
      // worst a tenant-rewrite attack from a hook that returned
      // `{ ...input, userId: 'attacker' }`. Strip both fields from
      // the persisted payload — the existing values on the doc are
      // already correct.
      stripTenantFields(stamped);
      rp.args.record = stamped;
    } else if (isDelete && hookName && schema && schema.hooks && schema.hooks[hookName]) {
      await runBeforeHook(schema, hookName, {
        input: null,
        current,
        user,
      });
    }

    const result = await next(rp);
    if (isUpdate) emitForMutation(schema, 'updated', user, result);
    else if (isDelete) emitForMutation(schema, 'deleted', user, result);
    const projected = projectResult(result, schema, user);
    if (afterHookName && schema && schema.hooks && schema.hooks[afterHookName]) {
      const recordOut = projected && projected.record ? projected.record : null;
      await runAfterHook(
        schema,
        afterHookName,
        {
          record: recordOut,
          previous: current,
          user,
        },
        logger
      );
    }
    return projected;
  });
};

/**
 * Wrap an aggregation runner into a graphql-compose field config.
 *
 * Aggregations don't fit the graphql-compose-mongoose resolver shape
 * (they aren't `findMany`, `findById`, etc.), so they don't pass
 * through wrapFilter / wrapByIdMutation / etc. — but the same tenant
 * isolation contract still applies, and CLAUDE.md mandates that every
 * GraphQL resolver for tenant-scoped data go through this module.
 * This wrapper is the aggregation-shaped entry point: it enforces
 * authentication, hands the runner the authenticated user, and
 * returns the field config the schema composer expects.
 *
 * Tenant isolation itself lives inside `runner` — it builds the
 * pipeline with a non-bypassable `$match: { userId }` from the
 * authenticated user — so this wrapper's only job is to gate
 * unauthenticated callers and pass `ctx.user` through.
 */
const wrapAggregation = ({ type, args, description, runner }) => ({
  type,
  args,
  description,
  resolve: async (_root, params, ctx) => {
    if (!ctx || !ctx.user || !ctx.user.user_id) {
      throw new AuthenticationError('Authentication required');
    }
    return runner({ user: ctx.user, params });
  },
});

/**
 * Wrap a computed-field resolver into a graphql-compose field config.
 *
 * Computed fields are TC-added (not graphql-compose-mongoose
 * resolvers), so they don't fit `wrapFilter` / `wrapFindById` / etc.
 * But CLAUDE.md still requires every tenant-scoped GraphQL resolver
 * to go through this module — `wrapComputedField` is the
 * computed-shaped entry point. It:
 *
 *   - Threads `field` (for ACL semantics + projection hints) and
 *     `type` (the GraphQL scalar string) into the field config.
 *   - Calls `canReadField` on every resolve so a caller without the
 *     declared `acl.read` role gets `null` instead of the value.
 *     There's no projectByAcl pass on TC-resolved fields, so the
 *     resolver is the enforcement site.
 *   - Catches throws from `compute(source, ctx)` and returns `null`,
 *     mirroring REST's `applyComputed` resilience contract — one
 *     bad computed shouldn't fail the whole GraphQL response.
 *   - Hands the computed function the request user (from ctx) so
 *     ctx.find / ctx.count stay tenant-scoped.
 *
 * `compute` is the schema-declared `(record, computedCtx) => value`
 * function. `buildContext({ user })` is a callback the loader
 * supplies that constructs the per-call computed-context (including
 * cross-resource helpers).
 */
const wrapComputedField = ({ type, description, projection, field, compute, buildContext, log }) => ({
  type,
  description,
  projection,
  resolve: async (source, _args, ctx) => {
    const user = ctx && ctx.user;
    if (!canReadField(field, user)) return null;
    try {
      return await compute(source, buildContext({ user }));
    } catch (err) {
      if (log && log.warn) {
        log.warn(
          { err, field: field && field.name },
          'computed field threw; returning null'
        );
      }
      return null;
    }
  },
});

/**
 * Wrap a state-machine transition into a graphql-compose mutation
 * field config.
 *
 * Transitions don't fit graphql-compose-mongoose's `updateById`
 * shape (the args are `{ _id, to }`, not `{ _id, record }`), so
 * they don't go through `wrapByIdMutation`. This is the
 * transition-shaped entry point: it enforces auth, fetches the
 * record under the caller's tenant, hands the runner the
 * authenticated user + the record + the requested target state,
 * and returns the result with field-level read ACL applied
 * (matches the contract every other tenant-scoped wrapper
 * follows).
 *
 * `kind` and `action` are accepted for symmetry with the other
 * scope-resolver wrappers (`{ schema, kind: 'write', action:
 * 'update' }` is the natural default for a transition mutation),
 * even though `wrapStateTransition` enforces ownership directly
 * via the unique `(key, userId)` query rather than delegating to
 * the bypass slots — same posture as `wrapByIdMutation`. Passing
 * the options keeps authorisation auditing consistent across
 * wrappers.
 *
 * Tenant isolation lives in the ownership query the wrapper
 * itself runs (`{ _id: args._id, userId }`) — the runner gets a
 * record it's already authorised to mutate.
 */
const wrapStateTransition = ({
  type,
  args,
  description,
  Model,
  runner,
  schema,
  // kind/action carried for convention only — see comment above.
  // eslint-disable-next-line no-unused-vars
  kind = 'write',
  // eslint-disable-next-line no-unused-vars
  action = 'update',
} = {}) => ({
  type,
  args,
  description,
  resolve: async (_root, params, ctx) => {
    if (!ctx || !ctx.user || !ctx.user.user_id) {
      throw new AuthenticationError('Authentication required');
    }
    const ownership = { _id: params._id, userId: ctx.user.user_id };
    const before = await Model.findOne(ownership).lean();
    if (!before) throw new ForbiddenError('Record not found');
    const result = await runner({ user: ctx.user, before, to: params.to });
    // Apply field-level read ACL on the way out — same contract
    // wrapFilter / wrapByIdMutation enforce so the Transition
    // mutation can't be used as a side channel to read fields the
    // caller would otherwise have stripped from the response.
    return projectResult(result, schema, ctx.user);
  },
});

module.exports = {
  wrapFilter,
  wrapCreateOne,
  wrapCreateMany,
  wrapFindById,
  wrapFindByIds,
  wrapByIdMutation,
  wrapAggregation,
  wrapComputedField,
  wrapStateTransition,
};
