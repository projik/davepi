'use strict';

const path = require('node:path');
const { loadSchemaSandboxed } = require('../../lib/load-schema');

module.exports = function checkAggregation(projectRoot) {
  const schema = loadSchemaSandboxed(path.join(projectRoot, 'schema/versions/v1/task.js'));

  const aggs = schema.aggregations || [];
  const agg = aggs.find((a) => a && a.name === 'countByStatus');
  if (!agg) return { ok: false, message: 'aggregation countByStatus is missing' };

  if (!Array.isArray(agg.pipeline) || agg.pipeline.length === 0) {
    return { ok: false, message: 'aggregation pipeline must be a non-empty array' };
  }

  // Find a $group stage that groups by $status.
  const groupStage = agg.pipeline.find((s) => s && s.$group);
  if (!groupStage) return { ok: false, message: 'pipeline must include a $group stage' };
  const group = groupStage.$group;
  if (group._id !== '$status') {
    return { ok: false, message: `$group._id should be '$status', got ${JSON.stringify(group._id)}` };
  }

  // Must include a count accumulator. Tolerate any field name as
  // long as it's a $sum: 1.
  const accumulators = Object.entries(group).filter(([k]) => k !== '_id');
  const counter = accumulators.find(([, v]) => v && typeof v === 'object' && v.$sum === 1);
  if (!counter) {
    return { ok: false, message: '$group must include a $sum: 1 counter' };
  }

  // Sanity: the agent shouldn't have inserted a tenant $match — the
  // framework does that. If they did, it's not strictly wrong, just
  // redundant; we don't fail it.

  return { ok: true };
};
