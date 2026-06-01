const { ValidationError } = require('./errors');
const { projectByAcl } = require('./acl');

/**
 * Relations engine: compile each schema's `relations` map (and the
 * legacy `field.reference` shorthand) into a single normalized form,
 * and apply `__include`-driven population to a list of parent records
 * in O(1) batched queries per relation.
 *
 * Design choices:
 *   - Single round-trip per relation. `applyIncludes` collects every
 *     parent's IDs first, fires one find against the target collection,
 *     and then bucket-maps the children back. This keeps the include
 *     layer flat under list-with-pagination workloads — no N+1.
 *   - Tenant isolation is non-bypassable. Every related find re-applies
 *     `userId: user.user_id` even though the parent's tenancy was
 *     already verified at the top of the request. A cross-collection
 *     `_id` could theoretically belong to another tenant, so we never
 *     trust the parent record's tenancy alone.
 *   - Soft-delete tombstones are filtered out of relations regardless
 *     of the parent request's `__includeDeleted` flag. Mongo's
 *     `deletedAt: null` predicate matches both null AND missing fields,
 *     so the same query is correct against soft-delete-enabled and
 *     soft-delete-disabled targets.
 *   - Each populated record is run through the target schema's ACL
 *     projector so a user who can read account but can't read
 *     `task.privateNotes` doesn't get those fields leaked sideways
 *     through `__include=tasks`.
 *   - Depth is capped at 1: `__include=tasks.subtasks` is not supported
 *     in v1. Nested includes are a follow-up.
 */

const ALLOWED_KINDS = ['belongsTo', 'hasMany', 'hasOne'];

/**
 * Compile a schema's `relations` map plus any `field.reference`
 * shorthand into a normalized `{ name -> def }` map. Each def has a
 * `kind` ('belongsTo' | 'hasMany' | 'hasOne'), a `target` (the path of
 * the related schema), the join keys, and an optional `where` filter.
 *
 * `field.reference: 'x'` is preserved as a synthetic belongsTo so
 * existing schemas keep working — but the populated value now goes
 * onto the field name itself only when explicitly opted in via
 * `__include`. The legacy "always populate on GET /:id" behaviour is
 * gone.
 */
function normalizeRelations(schema) {
  const out = {};

  const explicit = schema && schema.relations;
  if (explicit && typeof explicit === 'object') {
    for (const [name, def] of Object.entries(explicit)) {
      if (!def || typeof def !== 'object') continue;
      const declared = ALLOWED_KINDS.find((k) => def[k]);
      if (!declared) continue;
      const target = def[declared];
      if (declared === 'belongsTo') {
        out[name] = {
          kind: 'belongsTo',
          target,
          // Convention: localKey defaults to `${name}Id` so a relation
          // called `owner` joins via the parent's `ownerId` column
          // unless the schema spells it out.
          localKey: def.localKey || `${name}Id`,
          where: null,
        };
      } else {
        out[name] = {
          kind: declared,
          target,
          // hasMany / hasOne require an explicit foreignKey — there is
          // no safe default for "what column on the child points back
          // here". Skip the relation if it's missing rather than
          // building a query that matches the wrong column.
          foreignKey: def.foreignKey || null,
          where: def.where && typeof def.where === 'object' ? def.where : null,
        };
      }
    }
  }

  // Collect the localKeys already covered by an explicit belongsTo so
  // the shorthand pass below can skip them. Without this dedup, a
  // schema that declares both `field.reference: 'X'` and an explicit
  // `relations.foo.belongsTo: 'X'` pointing at the same local key
  // would emit two belongsTo entries — one named `foo`, one named
  // after the field — producing duplicate `__include` names, duplicate
  // MCP relation tools, and (when the relation name isn't the same as
  // the field) a confusing two-edges-for-one-join graph.
  const explicitLocalKeys = new Set(
    Object.values(out)
      .filter((def) => def && def.kind === 'belongsTo' && def.localKey)
      .map((def) => def.localKey)
  );

  // field.reference: 'x' shorthand: synthesise a belongsTo whose
  // local key IS the field. The relation name equals the field name,
  // so `__include=accountId` on a record with `accountId: '...'` swaps
  // the ID string out for the populated object.
  //
  // The `fromShorthand` flag tells the GraphQL layer to skip these:
  // a relation name that collides with an existing scalar field on
  // the type can't be added as a graph edge. REST tolerates the
  // collision because JSON output naturally accepts either an ID
  // string or a populated object at the same key.
  for (const f of (schema && schema.fields) || []) {
    if (!f || !f.reference || out[f.name]) continue;
    // Already covered by an explicit belongsTo on the same localKey?
    // Keep `field.reference` on the schema (UI consumers still read it
    // for RelationPicker) but don't duplicate the runtime relation.
    if (explicitLocalKeys.has(f.name)) continue;
    out[f.name] = {
      kind: 'belongsTo',
      target: f.reference,
      localKey: f.name,
      where: null,
      fromShorthand: true,
    };
  }

  return out;
}

/**
 * Parse and validate an `__include=a,b,c` query string. Unknown
 * relation names produce a 400 — silent fallthrough would let typos
 * mask programming errors and give callers the impression they're
 * getting eager loading when they aren't.
 */
function parseIncludes(rawInclude, normalized) {
  if (rawInclude == null || rawInclude === '') return [];
  const requested = String(rawInclude)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!requested.length) return [];
  const unknown = requested.filter(
    (r) => !Object.prototype.hasOwnProperty.call(normalized, r)
  );
  if (unknown.length) {
    const allowed = Object.keys(normalized);
    throw new ValidationError(
      `Unknown __include relation(s): ${unknown.join(', ')}` +
        (allowed.length ? `. Allowed: ${allowed.join(', ')}` : '')
    );
  }
  return requested;
}

/**
 * Mutate `records` in place to attach populated relation values for
 * each include. One mongo round-trip per relation, regardless of
 * record count.
 *
 * `getResource(targetPath)` is a callback that resolves the target
 * path back to its `{ schema, model }` pair from the loader's
 * registry — relations.js doesn't import schemaLoader to avoid a
 * cycle.
 */
async function applyIncludes(records, normalized, includes, { user, getResource }) {
  if (!includes.length || !records.length) return records;
  for (const name of includes) {
    const def = normalized[name];
    if (!def) continue;
    const target = getResource(def.target);
    if (!target || !target.model) {
      // Target schema isn't loaded — skip rather than crash. This can
      // legitimately happen during hot-reload before the target is
      // registered, or if a schema declares a relation to a path that
      // simply doesn't exist (typo). The 400 from parseIncludes is
      // gated on the relation being declared, not on the target
      // existing, so this is the right defensive path.
      for (const r of records) {
        r[name] = def.kind === 'hasMany' ? [] : null;
      }
      continue;
    }
    const { schema: targetSchema, model: TargetModel } = target;
    const tenantId = user && user.user_id;

    if (def.kind === 'belongsTo') {
      const ids = records
        .map((r) => r[def.localKey])
        .filter((v) => v != null && v !== '');
      if (!ids.length) {
        for (const r of records) r[name] = null;
        continue;
      }
      const refs = await TargetModel.find({
        _id: { $in: ids },
        userId: tenantId,
        deletedAt: null,
      }).lean();
      const projected = refs.map((ref) =>
        projectByAcl(ref, targetSchema, user)
      );
      const byId = new Map(projected.map((r) => [String(r._id), r]));
      for (const r of records) {
        r[name] = byId.get(String(r[def.localKey])) || null;
      }
      continue;
    }

    // hasMany / hasOne both need the foreign key set. Misconfigured
    // relations get an empty value rather than a misleading match.
    if (!def.foreignKey) {
      for (const r of records) {
        r[name] = def.kind === 'hasMany' ? [] : null;
      }
      continue;
    }

    const parentIds = records.map((r) => r._id).filter(Boolean);
    const baseFilter = {
      [def.foreignKey]: { $in: parentIds },
      userId: tenantId,
      deletedAt: null,
      ...(def.where || {}),
    };
    const matches = await TargetModel.find(baseFilter).lean();

    // Critical ordering: read the join key off the RAW match, then
    // project. If we projected first, an ACL'd foreignKey field on
    // the target schema would be stripped before grouping and every
    // relation would silently return empty buckets.
    if (def.kind === 'hasMany') {
      const byParent = new Map();
      for (const m of matches) {
        const k = String(m[def.foreignKey]);
        const projectedChild = projectByAcl(m, targetSchema, user);
        if (!byParent.has(k)) byParent.set(k, []);
        byParent.get(k).push(projectedChild);
      }
      for (const r of records) r[name] = byParent.get(String(r._id)) || [];
    } else {
      // hasOne: keep the first match per parent. Mongo doesn't
      // guarantee an order without sort(), so this is "any one match"
      // — which is fine if the schema's `where` filter is selective
      // enough (e.g. `isPrimary: true`).
      const byParent = new Map();
      for (const m of matches) {
        const k = String(m[def.foreignKey]);
        if (byParent.has(k)) continue;
        byParent.set(k, projectByAcl(m, targetSchema, user));
      }
      for (const r of records) r[name] = byParent.get(String(r._id)) || null;
    }
  }
  return records;
}

module.exports = {
  normalizeRelations,
  parseIncludes,
  applyIncludes,
  ALLOWED_KINDS,
};
