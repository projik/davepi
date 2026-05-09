const { AuthenticationError, ForbiddenError } = require('apollo-server-express');

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

const wrapFilter = (resolver) => {
  stripFromInput(resolver, 'record');
  return resolver.wrapResolve((next) => (rp) => {
    const userId = requireUser(rp);
    rp.args.filter = { ...(rp.args.filter || {}), userId };
    if (rp.args.record) {
      rp.args.record = { ...rp.args.record, ...stampedValues(userId) };
    }
    return next(rp);
  });
};

const wrapCreateOne = (resolver) => {
  stripFromInput(resolver, 'record');
  return resolver.wrapResolve((next) => (rp) => {
    const userId = requireUser(rp);
    rp.args.record = { ...(rp.args.record || {}), ...stampedValues(userId) };
    return next(rp);
  });
};

const wrapCreateMany = (resolver) => {
  stripFromInput(resolver, 'records');
  return resolver.wrapResolve((next) => (rp) => {
    const userId = requireUser(rp);
    rp.args.records = (rp.args.records || []).map((r) => ({
      ...r,
      ...stampedValues(userId),
    }));
    return next(rp);
  });
};

const wrapFindById = (resolver) =>
  resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const result = await next(rp);
    if (!result) return null;
    return sameId(result.userId, userId) ? result : null;
  });

const wrapFindByIds = (resolver) =>
  resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const results = await next(rp);
    return (results || []).filter((r) => sameId(r.userId, userId));
  });

const wrapByIdMutation = (Model) => (resolver) => {
  stripFromInput(resolver, 'record');
  return resolver.wrapResolve((next) => async (rp) => {
    const userId = requireUser(rp);
    const exists = await Model.findOne({ _id: rp.args._id, userId })
      .select('_id')
      .lean();
    if (!exists) throw new ForbiddenError('Record not found');
    if (rp.args.record) {
      rp.args.record = { ...rp.args.record, ...stampedValues(userId) };
    }
    return next(rp);
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
