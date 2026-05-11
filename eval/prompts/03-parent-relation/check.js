'use strict';

const path = require('node:path');
const { loadSchemaSandboxed } = require('../../lib/load-schema');

module.exports = function checkParentRelation(projectRoot) {
  const schema = loadSchemaSandboxed(path.join(projectRoot, 'schema/versions/v1/task.js'));

  const projectId = schema.fields.find((f) => f && f.name === 'projectId');
  if (!projectId) return { ok: false, message: 'projectId field is missing' };
  if (projectId.type !== String) {
    return { ok: false, message: 'projectId must be type String' };
  }
  if (projectId.required !== true) {
    return { ok: false, message: 'projectId must be required: true' };
  }

  const rel = schema.relations && schema.relations.parent;
  if (!rel) return { ok: false, message: 'relations.parent is missing' };
  if (rel.belongsTo !== 'project') {
    return { ok: false, message: `relations.parent.belongsTo should be 'project', got ${JSON.stringify(rel.belongsTo)}` };
  }
  if (rel.fk !== 'projectId') {
    return { ok: false, message: `relations.parent.fk should be 'projectId', got ${JSON.stringify(rel.fk)}` };
  }

  return { ok: true };
};
