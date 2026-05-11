'use strict';

const path = require('node:path');
const { loadSchemaSandboxed } = require('../../lib/load-schema');

module.exports = function checkAclAdminDelete(projectRoot) {
  const schema = loadSchemaSandboxed(path.join(projectRoot, 'schema/versions/v1/task.js'));

  if (!schema.acl || typeof schema.acl !== 'object') {
    return { ok: false, message: 'schema.acl is missing' };
  }
  if (!Array.isArray(schema.acl.delete)) {
    return { ok: false, message: 'schema.acl.delete must be an array' };
  }
  if (!schema.acl.delete.includes('admin')) {
    return { ok: false, message: `acl.delete must include 'admin'; got ${JSON.stringify(schema.acl.delete)}` };
  }
  // Specifically NOT requiring a list ACL — the prompt asked only
  // about delete restriction, default owner-only reads stay in place.

  return { ok: true };
};
