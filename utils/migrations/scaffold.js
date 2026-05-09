const fs = require('fs');
const path = require('path');
const { diffVersions } = require('./diff');

/**
 * Generate timestamped migration filenames. The lexical-sort order
 * matches the chronological intent so the runner picks them up in
 * authorship order.
 */
function timestampSlug(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function safeSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'migration';
}

function scaffoldFromTemplate(slug) {
  return `module.exports = {
  description: ${JSON.stringify(slug)},

  // Apply the change. \`db\` is the raw MongoDB driver db handle —
  // not Mongoose — so use \`db.collection('foo').updateMany(...)\`
  // etc. Keep operations idempotent so a half-applied migration can
  // be retried safely.
  async up(db) {
    // TODO: implement
  },

  // Reverse the change. Used by \`davepi migrate:down\`.
  async down(db) {
    // TODO: implement
  },
};
`;
}

/**
 * For a small set of common cases (renames, additions, removals,
 * trivial type coercions), pre-fill an `up()` and `down()` from the
 * structural diff. Anything more complex falls back to the empty
 * scaffold above.
 *
 * Renames are inferred only when a single field is `removed` and a
 * single field is `added` on the same resource — anything richer is
 * ambiguous and the developer should write the body by hand.
 */
function scaffoldFromDiff(diff) {
  const ups = [];
  const downs = [];
  let hasContent = false;

  for (const a of diff.added || []) {
    hasContent = true;
    ups.push(`    // Schema added: ${a.path} → collection ${a.collection}.`);
    ups.push(`    // Data migration is rarely needed; this is a no-op.`);
    downs.push(`    await db.collection(${JSON.stringify(a.collection)}).drop().catch(() => {});`);
  }
  for (const r of diff.removed || []) {
    hasContent = true;
    ups.push(`    // Schema removed: ${r.path} → collection ${r.collection}.`);
    ups.push(`    // The framework no longer registers it; data lingers until purged.`);
    ups.push(`    // await db.collection(${JSON.stringify(r.collection)}).drop();`);
    downs.push(`    // No automatic restore — recreate the schema and re-seed manually.`);
  }
  for (const c of diff.changed || []) {
    const fields = c.fields;
    // Single-add + single-remove → likely a rename.
    if (fields.added.length === 1 && fields.removed.length === 1 && fields.changed.length === 0) {
      const oldName = fields.removed[0];
      const newName = fields.added[0];
      hasContent = true;
      ups.push(
        `    // ${c.path}: rename ${oldName} → ${newName}`
      );
      ups.push(
        `    await db.collection(${JSON.stringify(c.collection)}).updateMany(`
      );
      ups.push(`      { ${JSON.stringify(oldName)}: { $exists: true } },`);
      ups.push(`      [`);
      ups.push(`        { $set: { ${JSON.stringify(newName)}: '$${oldName}' } },`);
      ups.push(`        { $unset: ${JSON.stringify(oldName)} }`);
      ups.push(`      ]`);
      ups.push(`    );`);
      downs.push(
        `    await db.collection(${JSON.stringify(c.collection)}).updateMany(`
      );
      downs.push(`      { ${JSON.stringify(newName)}: { $exists: true } },`);
      downs.push(`      [`);
      downs.push(`        { $set: { ${JSON.stringify(oldName)}: '$${newName}' } },`);
      downs.push(`        { $unset: ${JSON.stringify(newName)} }`);
      downs.push(`      ]`);
      downs.push(`    );`);
      continue;
    }
    for (const name of fields.added) {
      hasContent = true;
      ups.push(`    // ${c.path}: field ${name} added — no backfill scaffolded`);
      downs.push(
        `    await db.collection(${JSON.stringify(c.collection)}).updateMany({}, { $unset: { ${JSON.stringify(name)}: '' } });`
      );
    }
    for (const name of fields.removed) {
      hasContent = true;
      ups.push(
        `    await db.collection(${JSON.stringify(c.collection)}).updateMany({}, { $unset: { ${JSON.stringify(name)}: '' } });`
      );
      downs.push(`    // ${c.path}: field ${name} removed — restore requires a backfill`);
    }
    for (const change of fields.changed) {
      hasContent = true;
      ups.push(
        `    // ${c.path}.${change.name} changed: ${change.reasons
          .map((r) => `${r.kind} ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`)
          .join('; ')}`
      );
      downs.push(`    // Reverse manually for ${c.path}.${change.name}`);
    }
  }

  if (!hasContent) return null;
  return `module.exports = {
  description: 'auto-generated from schema diff',

  async up(db) {
${ups.join('\n')}
  },

  async down(db) {
${downs.join('\n')}
  },
};
`;
}

/**
 * Write a migration file under MIGRATIONS_DIR. Returns the absolute
 * path. If `fromVersion`/`toVersion` are supplied, the body is
 * pre-filled by scaffoldFromDiff; otherwise an empty template is
 * written.
 */
function writeScaffold({ name, dir, fromVersion, toVersion, schemasRoot } = {}) {
  const targetDir = path.resolve(dir || process.env.MIGRATIONS_DIR || './migrations');
  fs.mkdirSync(targetDir, { recursive: true });

  const slug = safeSlug(name || 'migration');
  const filename = `${timestampSlug()}-${slug}.js`;
  const full = path.join(targetDir, filename);

  let body = scaffoldFromTemplate(slug);
  if (fromVersion && toVersion) {
    const root = path.resolve(schemasRoot || './schema/versions');
    const diff = diffVersions(
      path.join(root, fromVersion),
      path.join(root, toVersion)
    );
    const auto = scaffoldFromDiff(diff);
    if (auto) body = auto;
  }
  fs.writeFileSync(full, body);
  return full;
}

module.exports = { writeScaffold, scaffoldFromDiff, timestampSlug, safeSlug };
