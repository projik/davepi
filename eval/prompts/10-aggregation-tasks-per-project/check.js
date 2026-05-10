'use strict';

const path = require('node:path');

module.exports = function checkCountByProject(projectRoot) {
  delete require.cache[require.resolve(path.join(projectRoot, 'schema/versions/v1/task.js'))];
  const schema = require(path.join(projectRoot, 'schema/versions/v1/task.js'));

  const aggs = schema.aggregations || [];
  const agg = aggs.find((a) => a && a.name === 'countByProject');
  if (!agg) return { ok: false, message: 'aggregation countByProject is missing' };

  // The original countByStatus aggregation should still be present —
  // the prompt explicitly says add this one alongside.
  if (!aggs.find((a) => a && a.name === 'countByStatus')) {
    return { ok: false, message: 'pre-existing aggregation countByStatus was removed' };
  }

  if (!Array.isArray(agg.pipeline) || agg.pipeline.length === 0) {
    return { ok: false, message: 'pipeline must be a non-empty array' };
  }

  const groupStage = agg.pipeline.find((s) => s && s.$group);
  if (!groupStage) return { ok: false, message: 'pipeline must include a $group stage' };
  if (groupStage.$group._id !== '$projectId') {
    return { ok: false, message: `$group._id should be '$projectId', got ${JSON.stringify(groupStage.$group._id)}` };
  }
  const accumulators = Object.entries(groupStage.$group).filter(([k]) => k !== '_id');
  const counter = accumulators.find(([, v]) => v && typeof v === 'object' && v.$sum === 1);
  if (!counter) return { ok: false, message: '$group must include a $sum: 1 counter' };

  // Sort by count descending must be present.
  const sortStage = agg.pipeline.find((s) => s && s.$sort);
  if (!sortStage) return { ok: false, message: 'pipeline must include a $sort stage' };
  const sortFields = Object.entries(sortStage.$sort);
  const sortByCount = sortFields.find(([, dir]) => dir === -1);
  if (!sortByCount) return { ok: false, message: '$sort must order by descending count (value -1)' };

  return { ok: true };
};
