'use strict';

const path = require('node:path');

module.exports = function checkTaskFields(projectRoot) {
  // require() the schema file — proves it parses and is a valid
  // CommonJS module. A typo or stray markdown fence in the file
  // would throw here, which the harness reports as failure.
  delete require.cache[require.resolve(path.join(projectRoot, 'schema/versions/v1/task.js'))];
  const schema = require(path.join(projectRoot, 'schema/versions/v1/task.js'));

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
