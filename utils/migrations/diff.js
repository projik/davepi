const fs = require('fs');
const path = require('path');

/**
 * Pure schema-diff helpers. Loads every schema in two version
 * directories under ./schema/versions and produces a structural
 * description of the changes between them.
 *
 * The output shape is intentionally schema-of-changes, not an
 * imperative script — the migration scaffolder consumes it to emit a
 * starter `up()` / `down()` while the diff CLI prints it for humans.
 */

const TYPE_NAME_FOR = (t) => {
  if (t == null) return 'unknown';
  if (typeof t === 'function') return t.name || String(t);
  if (Array.isArray(t)) return `[${TYPE_NAME_FOR(t[0])}]`;
  if (typeof t === 'string') return t;
  if (typeof t === 'object' && t.name) return t.name;
  return String(t);
};

function loadSchemasInDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.js')) continue;
    const full = path.resolve(dir, file);
    delete require.cache[require.resolve(full)];
    const s = require(full);
    if (s && typeof s === 'object' && s.path) out.push(s);
  }
  return out;
}

function indexByPath(schemas) {
  const map = new Map();
  for (const s of schemas) map.set(s.path, s);
  return map;
}

function fieldByName(schema) {
  const map = new Map();
  if (Array.isArray(schema && schema.fields)) {
    for (const f of schema.fields) map.set(f.name, f);
  }
  return map;
}

/**
 * Returns a per-field change set between two field arrays:
 *   { added: [name], removed: [name], changed: [{ name, type, required, ... }] }
 */
function diffFields(beforeFields, afterFields) {
  const before = fieldByName({ fields: beforeFields });
  const after = fieldByName({ fields: afterFields });
  const added = [];
  const removed = [];
  const changed = [];

  for (const [name, f] of after.entries()) {
    if (!before.has(name)) added.push(name);
  }
  for (const [name] of before.entries()) {
    if (!after.has(name)) removed.push(name);
  }
  for (const [name, b] of before.entries()) {
    const a = after.get(name);
    if (!a) continue;
    const reasons = [];
    if (TYPE_NAME_FOR(b.type) !== TYPE_NAME_FOR(a.type)) {
      reasons.push({
        kind: 'type',
        from: TYPE_NAME_FOR(b.type),
        to: TYPE_NAME_FOR(a.type),
      });
    }
    if (!!b.required !== !!a.required) {
      reasons.push({ kind: 'required', from: !!b.required, to: !!a.required });
    }
    if (JSON.stringify(b.enum || null) !== JSON.stringify(a.enum || null)) {
      reasons.push({ kind: 'enum', from: b.enum || null, to: a.enum || null });
    }
    if (!!b.unique !== !!a.unique) {
      reasons.push({ kind: 'unique', from: !!b.unique, to: !!a.unique });
    }
    if (reasons.length) changed.push({ name, reasons });
  }

  return { added, removed, changed };
}

/**
 * Compare two version directories and return a per-resource diff:
 *   {
 *     added: [{ path, fields }],            // schema introduced in `to`
 *     removed: [{ path, fields }],          // schema dropped between
 *     changed: [{ path, collection, fields: { added, removed, changed } }],
 *   }
 */
function diffVersions(fromDir, toDir) {
  const from = indexByPath(loadSchemasInDir(fromDir));
  const to = indexByPath(loadSchemasInDir(toDir));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [p, s] of to.entries()) {
    if (!from.has(p)) added.push({ path: p, collection: s.collection, fields: s.fields });
  }
  for (const [p, s] of from.entries()) {
    if (!to.has(p)) removed.push({ path: p, collection: s.collection, fields: s.fields });
  }
  for (const [p, b] of from.entries()) {
    const a = to.get(p);
    if (!a) continue;
    const fdiff = diffFields(b.fields, a.fields);
    if (fdiff.added.length || fdiff.removed.length || fdiff.changed.length) {
      changed.push({
        path: p,
        collection: a.collection || b.collection,
        fields: fdiff,
      });
    }
  }

  return { added, removed, changed };
}

function formatDiff(diff) {
  const lines = [];
  for (const a of diff.added) {
    lines.push(`+ schema ${a.path} (collection: ${a.collection})`);
  }
  for (const r of diff.removed) {
    lines.push(`- schema ${r.path} (collection: ${r.collection})`);
  }
  for (const c of diff.changed) {
    lines.push(`${c.path}`);
    for (const name of c.fields.added) lines.push(`  + ${name}`);
    for (const name of c.fields.removed) lines.push(`  - ${name}`);
    for (const change of c.fields.changed) {
      const summary = change.reasons
        .map((r) => `${r.kind}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`)
        .join('; ');
      lines.push(`  ~ ${change.name}: ${summary}`);
    }
  }
  if (lines.length === 0) lines.push('(no changes)');
  return lines.join('\n');
}

module.exports = {
  diffVersions,
  diffFields,
  formatDiff,
  loadSchemasInDir,
};
