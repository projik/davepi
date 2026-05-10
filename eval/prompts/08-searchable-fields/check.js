'use strict';

const path = require('node:path');

module.exports = function checkSearchable(projectRoot) {
  delete require.cache[require.resolve(path.join(projectRoot, 'schema/versions/v1/task.js'))];
  const schema = require(path.join(projectRoot, 'schema/versions/v1/task.js'));

  const description = schema.fields.find((f) => f && f.name === 'description');
  if (!description) return { ok: false, message: 'description field is missing' };
  if (description.type !== String) {
    return { ok: false, message: 'description must be type String' };
  }
  if (description.searchable !== true) {
    return { ok: false, message: 'description must be searchable: true' };
  }

  const title = schema.fields.find((f) => f && f.name === 'title');
  if (!title) return { ok: false, message: 'title field was removed' };
  if (title.searchable !== true) {
    return { ok: false, message: 'title must be searchable: true' };
  }

  return { ok: true };
};
