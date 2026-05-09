const mongoose = require('mongoose');

/**
 * Sub-document shape stored on records for a `type: 'File'` schema
 * field. The framework owns this shape — clients never POST it
 * directly; they upload via the dedicated multipart route.
 */
const FileMetaSchema = new mongoose.Schema(
  {
    key: String,
    bucket: String,
    size: Number,
    contentType: String,
    originalName: String,
    uploadedAt: Date,
  },
  { _id: false }
);

const isFileField = (f) => f && f.type === 'File';

const fileFieldsOf = (schema) =>
  Array.isArray(schema && schema.fields)
    ? schema.fields.filter(isFileField)
    : [];

/**
 * Convert a schema field's `type` for Mongoose. Files become
 * embedded sub-docs; everything else is unchanged.
 */
const mongooseTypeFor = (f) => {
  if (isFileField(f)) return { type: FileMetaSchema, default: null };
  return f;
};

const matchAccept = (mime, accept) => {
  if (!Array.isArray(accept) || accept.length === 0) return true;
  for (const pattern of accept) {
    if (pattern === mime) return true;
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      if (mime.startsWith(prefix + '/')) return true;
    }
  }
  return false;
};

/**
 * Augment a record's File fields with a `url` so consumers don't have
 * to hand-build storage URLs. `access: 'private'` produces a short-
 * lived signed URL; otherwise a stable public URL.
 */
async function decorateFileUrls(record, schema, storage) {
  if (!record || !schema) return record;
  const fileFields = fileFieldsOf(schema);
  if (fileFields.length === 0) return record;
  for (const f of fileFields) {
    const meta = record[f.name];
    if (!meta || !meta.key) continue;
    const access = (f.file && f.file.access) || 'public';
    const url =
      access === 'private'
        ? await storage.signedUrl(meta.key)
        : storage.publicUrl(meta.key);
    record[f.name] = { ...meta, url };
  }
  return record;
}

async function decorateListFileUrls(records, schema, storage) {
  if (!Array.isArray(records)) return records;
  for (const r of records) await decorateFileUrls(r, schema, storage);
  return records;
}

module.exports = {
  FileMetaSchema,
  isFileField,
  fileFieldsOf,
  mongooseTypeFor,
  matchAccept,
  decorateFileUrls,
  decorateListFileUrls,
};
