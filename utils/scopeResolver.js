const { AuthenticationError, ForbiddenError } = require('apollo-server-express');
const {
  projectByAcl,
  filterWritable,
  bypassUserScopeForList,
  bypassUserScopeForDelete,
} = require('./acl');

const STAMPED_FIELDS = ['userId', 'accountId'];

const requireUser = (rp) => {
  const userId = rp.context && rp.context.user && rp.context.user.user_id;
  if (!userId) throw new AuthenticationError('Authentication required');
  return userId;
};

const sameId = (a, b) => String(a) === String(b);

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

    const bypass =
      (kind === 'read' && bypassUserScopeForList(schema, user)) ||
      (kind === 'delete' && bypassUserScopeForDelete(schema, user));

    rp.args.filter = {
      ...(rp.args.filter || {}),
      ...(bypass ? {} : { userId }),
    };

    if (rp.args.record) {
      rp.args.record = { ...rp.args.record, ...stampedValues(userId) };
      if (action) {
        rp.args.record = filterWritable(rp.args.record, schema, user, action);
      }
    }

    const result = await next(rp);
    return projectResult(result, schema, user);
  });
};

const wrapCreateOne = (resolver, { schema } = {}) => {
  stripFromInput(resolver, 'record');
  return resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const user = userFromContext(rp);
    let record = { ...(rp.args.record || {}), ...stampedValues(userId) };
    record = filterWritable(record, schema, user, 'create');
    rp.args.record = record;
    const result = await next(rp);
    return projectResult(result, schema, user);
  });
};

const wrapCreateMany = (resolver, { schema } = {}) => {
  stripFromInput(resolver, 'records');
  return resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const user = userFromContext(rp);
    rp.args.records = (rp.args.records || []).map((r) => {
      const stamped = { ...r, ...stampedValues(userId) };
      return filterWritable(stamped, schema, user, 'create');
    });
    const result = await next(rp);
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
    return projectResult(result, schema, user);
  });

const wrapFindByIds = (resolver, { schema } = {}) =>
  resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const user = userFromContext(rp);
    ensureProjection(rp, ['userId']);
    const results = await next(rp);
    const bypass = bypassUserScopeForList(schema, user);
    const filtered = bypass
      ? results || []
      : (results || []).filter((r) => sameId(r.userId, userId));
    return projectResult(filtered, schema, user);
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

    const bypass =
      (kind === 'read' && bypassUserScopeForList(schema, user)) ||
      (kind === 'delete' && bypassUserScopeForDelete(schema, user));

    const ownershipQuery = bypass
      ? { _id: rp.args._id }
      : { _id: rp.args._id, userId };

    const exists = await Model.findOne(ownershipQuery).select('_id').lean();
    if (!exists) throw new ForbiddenError('Record not found');

    if (rp.args.record) {
      let record = { ...rp.args.record, ...stampedValues(userId) };
      if (action) record = filterWritable(record, schema, user, action);
      rp.args.record = record;
    }

    const result = await next(rp);
    return projectResult(result, schema, user);
  });
};

module.exports = {
  wrapFilter,
  wrapCreateOne,
  wrapCreateMany,
  wrapFindById,
  wrapFindByIds,
  wrapByIdMutation,
};
