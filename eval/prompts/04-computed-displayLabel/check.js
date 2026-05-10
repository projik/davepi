'use strict';

const path = require('node:path');

module.exports = function checkComputedDisplayLabel(projectRoot) {
  delete require.cache[require.resolve(path.join(projectRoot, 'schema/versions/v1/task.js'))];
  const schema = require(path.join(projectRoot, 'schema/versions/v1/task.js'));

  const field = schema.fields.find((f) => f && f.name === 'displayLabel');
  if (!field) return { ok: false, message: 'displayLabel field is missing' };
  if (field.type !== String) {
    return { ok: false, message: 'displayLabel must be type String' };
  }
  if (typeof field.computed !== 'function') {
    return { ok: false, message: 'displayLabel must have a computed function' };
  }

  // Functional check — call the computed and see that it returns
  // something sensible for a sample record. We don't enforce an
  // exact string format, just that the title and status show up.
  const sample = { title: 'Write docs', status: 'in_progress' };
  let output;
  try {
    output = field.computed(sample);
  } catch (err) {
    return { ok: false, message: `computed threw: ${err.message}` };
  }
  if (typeof output !== 'string') {
    return { ok: false, message: `computed returned ${typeof output}, expected string` };
  }
  if (!output.includes('Write docs')) {
    return { ok: false, message: `computed output must include the title; got '${output}'` };
  }
  if (!output.includes('in_progress')) {
    return { ok: false, message: `computed output must include the status; got '${output}'` };
  }

  return { ok: true };
};
