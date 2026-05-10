'use strict';

const path = require('node:path');

module.exports = function checkInternalNotes(projectRoot) {
  delete require.cache[require.resolve(path.join(projectRoot, 'schema/versions/v1/task.js'))];
  const schema = require(path.join(projectRoot, 'schema/versions/v1/task.js'));

  const field = schema.fields.find((f) => f && f.name === 'internalNotes');
  if (!field) return { ok: false, message: 'internalNotes field is missing' };
  if (field.type !== String) {
    return { ok: false, message: 'internalNotes must be type String' };
  }
  if (!field.acl || !Array.isArray(field.acl.read)) {
    return { ok: false, message: 'internalNotes must have acl.read = [...]' };
  }
  if (!field.acl.read.includes('admin')) {
    return { ok: false, message: `internalNotes.acl.read must include 'admin'; got ${JSON.stringify(field.acl.read)}` };
  }
  // The prompt explicitly says writes should NOT be restricted — flag
  // an over-eager agent that adds acl.create / acl.update.
  if (field.acl.create || field.acl.update) {
    return {
      ok: false,
      message: 'internalNotes must NOT restrict create/update — owners should still be able to write notes for their own tasks',
    };
  }

  return { ok: true };
};
