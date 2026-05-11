'use strict';

const path = require('node:path');
const { loadSchemaSandboxed } = require('../../lib/load-schema');

module.exports = function checkTaskFields(projectRoot) {
  // Load through the sandboxed loader so the agent's output can't
  // exfiltrate secrets via top-level side effects (no `require`,
  // `process`, or other Node globals inside the schema's scope).
  // Parse errors and missing exports surface as thrown errors, which
  // the harness reports as failure.
  const schema = loadSchemaSandboxed(path.join(projectRoot, 'schema/versions/v1/task.js'));

  const title = schema.fields.find((f) => f && f.name === 'title');
  if (!title) return { ok: false, message: 'task.title field is missing' };
  if (title.type !== String) {
    return { ok: false, message: 'task.title must be type String' };
  }
  if (title.required !== true) {
    return { ok: false, message: 'task.title must be required: true' };
  }

  const done = schema.fields.find((f) => f && f.name === 'done');
  if (!done) return { ok: false, message: 'task.done field is missing' };
  if (done.type !== Boolean) {
    return { ok: false, message: 'task.done must be type Boolean' };
  }
  if (done.default !== false) {
    return { ok: false, message: 'task.done must default to false' };
  }

  // userId must still be there — the agent shouldn't have removed it.
  const userId = schema.fields.find((f) => f && f.name === 'userId');
  if (!userId || userId.required !== true) {
    return { ok: false, message: 'userId field was removed or altered' };
  }

  return { ok: true };
};
