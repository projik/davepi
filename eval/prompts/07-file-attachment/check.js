'use strict';

const path = require('node:path');
const { loadSchemaSandboxed } = require('../../lib/load-schema');

module.exports = function checkFileAttachment(projectRoot) {
  const schema = loadSchemaSandboxed(path.join(projectRoot, 'schema/versions/v1/task.js'));

  const field = schema.fields.find((f) => f && f.name === 'attachment');
  if (!field) return { ok: false, message: 'attachment field is missing' };
  if (field.type !== 'File') {
    return { ok: false, message: `attachment.type must be 'File', got ${JSON.stringify(field.type)}` };
  }
  if (!field.file || typeof field.file !== 'object') {
    return { ok: false, message: 'attachment.file config object is missing' };
  }
  if (field.file.maxBytes !== 1024 * 1024) {
    return { ok: false, message: `attachment.file.maxBytes must be 1048576 (1 MB), got ${field.file.maxBytes}` };
  }
  if (!Array.isArray(field.file.accept) || !field.file.accept.includes('application/pdf')) {
    return { ok: false, message: `attachment.file.accept must include 'application/pdf'; got ${JSON.stringify(field.file.accept)}` };
  }
  // Reject overly-permissive accept lists — the prompt was PDFs ONLY.
  if (field.file.accept.length !== 1) {
    return {
      ok: false,
      message: `attachment.file.accept must be PDFs only; got ${JSON.stringify(field.file.accept)}`,
    };
  }

  return { ok: true };
};
