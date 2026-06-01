/**
 * Build the `GET /_describe` capability manifest from the live schema
 * registry. The manifest is a compact, agent-shaped projection of the
 * same metadata that drives REST/GraphQL/Swagger generation — built
 * fresh per request so hot-reloading a schema is reflected immediately.
 *
 * Compared to swagger.json, the manifest:
 *   - normalises mongoose types to friendly strings ("String", "[Number]")
 *   - exposes relations / aggregations / file fields / ACL / soft-delete
 *     / audit / search as first-class declarations rather than encoded
 *     as paths and parameters
 *   - lists the framework conventions (`__include`, `__q`, `__page`,
 *     pagination, soft-delete) so an agent has one place to look for
 *     "how do I use this API".
 */

const path = require('path');

const APP_PACKAGE_VERSION = (() => {
  try {
    return require(path.resolve('./package.json')).version;
  } catch (_) {
    return null;
  }
})();

const FIELD_KIND_LABELS = {
  String: 'String',
  Number: 'Number',
  Boolean: 'Boolean',
  Date: 'Date',
  Buffer: 'Buffer',
  ObjectId: 'ObjectId',
  Mixed: 'Mixed',
};

/**
 * Normalise a mongoose-style field type declaration into a string.
 * Handles the constructor forms (`String`, `Number`, ...) and array
 * shorthand (`[String]`). Falls back to the type's name (or `Mixed`)
 * for anything exotic so the manifest never breaks on an unknown.
 */
function describeFieldType(type) {
  if (type == null) return 'Mixed';
  if (Array.isArray(type)) {
    return `[${describeFieldType(type[0])}]`;
  }
  if (typeof type === 'function') {
    const n = type.name || 'Mixed';
    return FIELD_KIND_LABELS[n] || n;
  }
  if (typeof type === 'string') return type;
  if (typeof type === 'object' && type.type) {
    // Mongoose's expanded form: { type: String, ... }. Recurse on the
    // inner `type` so nested options don't change the type label.
    return describeFieldType(type.type);
  }
  return 'Mixed';
}

function describeFields(schema) {
  const out = [];
  for (const f of schema.fields || []) {
    if (!f || !f.name) continue;
    const entry = { name: f.name, type: describeFieldType(f.type) };
    if (f.required) entry.required = true;
    if (f.unique) entry.unique = true;
    if (f.default !== undefined) {
      // Functions (e.g. Date.now) aren't JSON-serialisable; surface
      // them as a stable token so the manifest stays diffable.
      entry.default = typeof f.default === 'function' ? '[fn]' : f.default;
    }
    if (f.reference) entry.reference = f.reference;
    if (f.searchable) {
      entry.searchable = true;
      if (f.searchWeight) entry.searchWeight = f.searchWeight;
    }
    if (Array.isArray(f.enum) && f.enum.length) {
      entry.enum = [...f.enum];
    }
    // Frontend hints — pure metadata, ignored by the backend. Travel
    // through to the manifest so `davepi-ui` (and any other agent
    // consuming `/_describe`) can pick the right widget without
    // re-deriving it from naming conventions. `label` overrides the
    // labelize() output; `widget` names a widget kind (`rich-text`,
    // `textarea`, `email`, `url`, `currency`, …); `format` carries a
    // value-formatting hint (`currency:USD`, `date`).
    if (typeof f.label === 'string' && f.label.length) entry.label = f.label;
    if (typeof f.widget === 'string' && f.widget.length) entry.widget = f.widget;
    if (typeof f.format === 'string' && f.format.length) entry.format = f.format;
    // `stamped: true` marks a field the server fills in from the JWT
    // (currently `userId` and `accountId` are the seed schemas' tenant
    // markers, but consumers may add others). The UI hides stamped
    // fields from create / edit forms so users never see a doomed
    // override of a tenant-controlled value. Strict-equality check
    // matches the validation discipline the other hints in this loop
    // use — a stray `stamped: 'yes'` or `stamped: {}` shouldn't survive
    // into the manifest where consumers would silently treat it as true.
    if (f.stamped === true) entry.stamped = true;
    if (f.acl && (f.acl.read || f.acl.create || f.acl.update)) {
      entry.acl = {};
      if (Array.isArray(f.acl.read)) entry.acl.read = f.acl.read;
      if (Array.isArray(f.acl.create)) entry.acl.create = f.acl.create;
      if (Array.isArray(f.acl.update)) entry.acl.update = f.acl.update;
    }
    // File metadata only attaches when the field is actually a file
    // field — `type: 'File'` is the framework's sole detection
    // criterion, so the manifest mirrors it strictly. A stray
    // `file: { ... }` block on a non-file field is ignored here.
    if (f.type === 'File') {
      entry.file = {};
      const cfg = f.file || {};
      if (cfg.maxBytes != null) entry.file.maxBytes = cfg.maxBytes;
      if (Array.isArray(cfg.accept) && cfg.accept.length) entry.file.accept = cfg.accept;
      entry.file.access = cfg.access || 'public';
    }
    out.push(entry);
  }
  return out;
}

function describeRelations(schema) {
  const rels = schema.relations;
  if (!rels || typeof rels !== 'object') return undefined;
  const out = {};
  for (const [name, def] of Object.entries(rels)) {
    if (!def || typeof def !== 'object') continue;
    if (def.belongsTo) {
      out[name] = {
        kind: 'belongsTo',
        target: def.belongsTo,
        localKey: def.localKey || `${name}Id`,
      };
    } else if (def.hasMany) {
      out[name] = { kind: 'hasMany', target: def.hasMany, foreignKey: def.foreignKey };
      if (def.where) out[name].where = def.where;
    } else if (def.hasOne) {
      out[name] = { kind: 'hasOne', target: def.hasOne, foreignKey: def.foreignKey };
      if (def.where) out[name].where = def.where;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// Match the loader's mount predicate exactly: an aggregation only
// produces live REST/GraphQL surface when it has a name AND a
// pipeline array. Filtering manifest output by the same rule keeps
// `_describe` honest — agents never see endpoint paths the server
// won't answer.
const isCallableAggregation = (a) =>
  a && typeof a.name === 'string' && Array.isArray(a.pipeline);

function describeAggregations(schema) {
  const aggs = schema.aggregations;
  if (!Array.isArray(aggs) || !aggs.length) return undefined;
  return aggs
    .filter(isCallableAggregation)
    .map((a) => {
      const out = { name: a.name };
      if (a.description) out.description = a.description;
      if (a.params && typeof a.params === 'object') {
        out.params = {};
        for (const [k, def] of Object.entries(a.params)) {
          out.params[k] = { type: def.type };
          if (def.required) out.params[k].required = true;
          if (def.description) out.params[k].description = def.description;
        }
      }
      if (a.cache && Number.isFinite(a.cache.ttlSeconds)) {
        out.cache = { ttlSeconds: a.cache.ttlSeconds };
      }
      if (a.unsafe) out.unsafe = true;
      if (a.maxResults) out.maxResults = a.maxResults;
      return out;
    });
}

function describeFileFields(schema) {
  const list = (schema.fields || []).filter((f) => f && f.type === 'File');
  if (!list.length) return undefined;
  return list.map((f) => {
    const cfg = f.file || {};
    const out = { name: f.name, access: cfg.access || 'public' };
    if (cfg.maxBytes != null) out.maxBytes = cfg.maxBytes;
    if (Array.isArray(cfg.accept) && cfg.accept.length) out.accept = cfg.accept;
    return out;
  });
}

function describeFeatures(schema) {
  const out = {
    softDelete: schema.softDelete !== false,
    audit: schema.audit !== false,
  };
  const searchable = (schema.fields || [])
    .filter((f) => f && f.searchable && f.name)
    .map((f) => f.name);
  if (searchable.length) out.search = searchable;
  return out;
}

function describeAcl(schema) {
  const a = schema.acl;
  if (!a || typeof a !== 'object') return undefined;
  const out = {};
  if (Array.isArray(a.list) && a.list.length) out.list = a.list;
  if (Array.isArray(a.delete) && a.delete.length) out.delete = a.delete;
  // Field-level ACL also surfaces through describeFields, but a
  // top-level `fields` summary makes it easy to spot "which fields are
  // gated for this resource" without iterating every field.
  const fieldAcl = {};
  for (const f of schema.fields || []) {
    if (f && f.acl && (f.acl.read || f.acl.create || f.acl.update)) {
      const slot = {};
      if (Array.isArray(f.acl.read)) slot.read = f.acl.read;
      if (Array.isArray(f.acl.create)) slot.create = f.acl.create;
      if (Array.isArray(f.acl.update)) slot.update = f.acl.update;
      fieldAcl[f.name] = slot;
    }
  }
  if (Object.keys(fieldAcl).length) out.fields = fieldAcl;
  return Object.keys(out).length ? out : undefined;
}

function describeEndpoints(schema) {
  const base = `/api/${schema.version}/${schema.path}`;
  // Express-style `:id` to match the actual mounted routes — the
  // manifest is call-oriented, not OpenAPI-templated. Agents copying
  // a path literally can substitute the ID without translating from
  // Swagger's `{id}` form.
  const item = `${base}/:id`;
  const out = {
    list: `GET    ${base}`,
    create: `POST   ${base}`,
    bulkPut: `PUT    ${base}`,
    get: `GET    ${item}`,
    update: `PUT    ${item}`,
    delete: `DELETE ${item}`,
    schema: `GET    ${base}-schema`,
  };
  if (schema.softDelete !== false) out.restore = `POST   ${item}/restore`;
  if (schema.audit !== false) out.history = `GET    ${item}/history`;

  const fileFields = (schema.fields || []).filter((f) => f && f.type === 'File');
  if (fileFields.length) {
    out.files = {};
    for (const f of fileFields) {
      out.files[f.name] = {
        upload: `POST   ${item}/${f.name}`,
        fetch: `GET    ${item}/${f.name}`,
        delete: `DELETE ${item}/${f.name}`,
      };
    }
  }

  const aggs = Array.isArray(schema.aggregations)
    ? schema.aggregations
        .filter(isCallableAggregation)
        .map((a) => `GET    ${base}/aggregations/${a.name}`)
    : [];
  if (aggs.length) out.aggregations = aggs;

  return out;
}

function describeGraphql(schema) {
  const p = schema.path;
  const queries = [
    `${p}ById`,
    `${p}ByIds`,
    `${p}One`,
    `${p}Many`,
    `${p}Count`,
    `${p}Connection`,
    `${p}Pagination`,
  ];
  const mutations = [
    `${p}CreateOne`,
    `${p}CreateMany`,
    `${p}UpdateById`,
    `${p}UpdateOne`,
    `${p}UpdateMany`,
    `${p}RemoveById`,
    `${p}RemoveMany`,
  ];
  // Per-aggregation top-level queries follow the same naming rule the
  // GraphQL builder uses: `${path}${PascalCaseName}`. Filter on the
  // same predicate the runtime uses so agents only see queries the
  // server will actually expose.
  if (Array.isArray(schema.aggregations)) {
    for (const a of schema.aggregations) {
      if (isCallableAggregation(a)) {
        queries.push(p + a.name.charAt(0).toUpperCase() + a.name.slice(1));
      }
    }
  }
  // Per-relation graph edges. The shorthand-derived relations are
  // skipped in GraphQL (they collide with the existing scalar field),
  // mirroring the rebuildGraphQL filter.
  const relations = [];
  if (schema.relations) {
    for (const [name, def] of Object.entries(schema.relations)) {
      if (def && (def.belongsTo || def.hasMany || def.hasOne)) {
        relations.push(`${p}.${name}`);
      }
    }
  }
  const out = { queries, mutations };
  if (relations.length) out.relations = relations;
  return out;
}

function describeSchemaEntry(entry) {
  const s = entry.schema;
  const out = {
    version: s.version,
    path: `/api/${s.version}/${s.path}`,
    collection: s.collection,
    fields: describeFields(s),
    features: describeFeatures(s),
    endpoints: describeEndpoints(s),
    graphql: describeGraphql(s),
  };
  if (s.description) out.description = s.description;
  // Frontend display hints — schema-level companions to the field-level
  // hints above. `label`/`pluralLabel` override the title-cased path the
  // UI generates by default; `displayField` names the field that should
  // be shown in relation pickers, breadcrumbs, and `<ResourceTable>`
  // previews — without this, `davepi-ui`'s `SchemaRegistry` has to sniff
  // for `name` / `title` / `accountName` heuristically.
  if (typeof s.label === 'string' && s.label.length) out.label = s.label;
  if (typeof s.pluralLabel === 'string' && s.pluralLabel.length) out.pluralLabel = s.pluralLabel;
  if (typeof s.displayField === 'string' && s.displayField.length) out.displayField = s.displayField;
  const relations = describeRelations(s);
  if (relations) out.relations = relations;
  const aggregations = describeAggregations(s);
  if (aggregations) out.aggregations = aggregations;
  const fileFields = describeFileFields(s);
  if (fileFields) out.fileFields = fileFields;
  const acl = describeAcl(s);
  if (acl) out.acl = acl;
  return out;
}

/**
 * Build the full manifest. `schemaLoader` is required; `appName` and
 * `version` are optional (they default to environment / package.json).
 *
 * Manifest schema keys mirror the loader's registry key shape
 * (`${version}/${path}`) so two versions of the same resource don't
 * collide. Each entry still carries `version` and `path` separately
 * for callers that prefer to look them up that way.
 */
function buildManifest({ schemaLoader, appName, version } = {}) {
  if (!schemaLoader) throw new Error('schemaLoader required');
  const schemas = {};
  for (const key of schemaLoader.listSchemas()) {
    const entry = schemaLoader.getEntry(key);
    if (!entry || !entry.schema) continue;
    schemas[`${entry.schema.version}/${entry.schema.path}`] = describeSchemaEntry(entry);
  }
  // Auto-populate inverse `hasMany` edges on every parent so frontends
  // can render a parent's child lists without the parent schema having
  // to declare the inverse manually. For every `belongsTo` on schema B
  // pointing at A, register `A.relations.<pluralised B path> = { kind:
  // 'hasMany', target: B.path, foreignKey: <localKey> }` — but only
  // when A doesn't already declare a relation against the same target +
  // foreign key, so consumer-authored explicit relations always win.
  populateInverseRelations(schemas);
  return {
    service: {
      name: appName || process.env.APP_NAME || 'dAvePi',
      version: version || APP_PACKAGE_VERSION || '0.0.0',
    },
    auth: {
      register: 'POST /register',
      login: 'POST /login',
      refresh: 'POST /auth/refresh',
      logout: 'POST /auth/logout',
      forgotPassword: 'POST /auth/forgot-password',
      resetPassword: 'POST /auth/reset-password',
    },
    conventions: {
      pagination: { page: '__page', perPage: 'PAGE_SIZE env (server-controlled)' },
      sort: '__sort=field:asc | field:desc | score (full-text rank, requires __q)',
      search: '__q=... (only on schemas with searchable fields)',
      softDelete: 'deletedAt tombstone; __includeDeleted=true to see soft-deleted records',
      include: '__include=relation,relation (single batched query per relation)',
      tenancy:
        'JWT user_id stamped on userId/accountId; ACL.list/delete bypass slots per schema',
    },
    graphql: {
      endpoint: 'POST /graphql/',
      sandbox: 'GET /graphql/ — Apollo Sandbox (development only — gated on NODE_ENV !== production)',
    },
    schemas,
  };
}

/**
 * Walk every manifest entry's declared `relations` block and, for each
 * `belongsTo` edge, attach the inverse `hasMany` edge to the parent
 * resource. Idempotent on re-invocation: a parent already declaring a
 * relation against the same target + foreign key is left untouched.
 *
 * Naming: the inverse edge is keyed by the pluralised child path
 * (`contact` → `contacts`). The framework's GraphQL builder declines to
 * register graph edges for schemas it doesn't recognise (mismatched
 * `target`), so an inverse pointing at a non-existent path is dropped
 * to avoid populating unreachable manifest entries.
 *
 * Multi-version targets: relation `target` values in schema files are
 * un-versioned (just the short `path`), but the manifest keys schemas
 * under `${version}/${path}` precisely so two versions of the same
 * resource don't collide. The resolver mirrors `schemaLoader.getResource`:
 * same-version exact match first, fall back to any-version. Without this,
 * a child on v2 declaring `belongsTo: 'account'` could synthesise its
 * inverse onto the wrong-version parent (last-write-wins on a flat
 * `byPath` index).
 *
 * Mutates the `schemas` map in place.
 */
function populateInverseRelations(schemas) {
  // Index by short path → version → entry. Iteration order is preserved
  // so the any-version fallback is deterministic across runs.
  const byPath = new Map();
  for (const entry of Object.values(schemas)) {
    const short = entry.path.replace(/^\/api\/[^/]+\//, '');
    let bucket = byPath.get(short);
    if (!bucket) {
      bucket = new Map();
      byPath.set(short, bucket);
    }
    bucket.set(entry.version, entry);
  }

  const resolveParent = (targetPath, sourceVersion) => {
    const bucket = byPath.get(targetPath);
    if (!bucket) return null;
    if (sourceVersion && bucket.has(sourceVersion)) return bucket.get(sourceVersion);
    // First entry wins for the any-version fallback — same posture as
    // `schemaLoader.getResource`, which iterates the registry and
    // returns the first match.
    const first = bucket.values().next();
    return first.done ? null : first.value;
  };

  for (const child of Object.values(schemas)) {
    if (!child.relations) continue;
    const childPath = child.path.replace(/^\/api\/[^/]+\//, '');
    for (const def of Object.values(child.relations)) {
      if (!def || def.kind !== 'belongsTo') continue;
      const parent = resolveParent(def.target, child.version);
      if (!parent) continue;
      const inverseName = pluralise(childPath);
      const fk = def.localKey || `${def.target}Id`;
      parent.relations = parent.relations || {};
      // Don't override an explicit declaration. The framework treats
      // consumer-authored relations as load-bearing — the inverse is a
      // convenience, not a source of truth.
      const exists = Object.values(parent.relations).some(
        (e) => e && e.target === childPath && e.foreignKey === fk
      );
      if (exists) continue;
      // Don't clobber an existing key (e.g. `contacts`) that already
      // points elsewhere — pick a disambiguated key.
      let key = inverseName;
      let suffix = 1;
      while (parent.relations[key]) {
        suffix += 1;
        key = `${inverseName}${suffix}`;
      }
      parent.relations[key] = {
        kind: 'hasMany',
        target: childPath,
        foreignKey: fk,
        inverse: true,
      };
    }
  }
}

/**
 * Pluralise an English-ish identifier for use as a relation key. Mirrors
 * the small ruleset davepi-ui's labelize uses (which itself was lifted
 * from the same conventions a typical Rails inflector covers), so the
 * key the backend emits matches the one the frontend would generate
 * locally and override consumer assertions don't drift.
 */
function pluralise(input) {
  if (!input) return input;
  if (/(s|x|z|ch|sh)$/i.test(input)) return `${input}es`;
  if (/[^aeiou]y$/i.test(input)) return `${input.slice(0, -1)}ies`;
  return `${input}s`;
}

module.exports = {
  buildManifest,
  describeFieldType,
  populateInverseRelations,
  pluralise,
};
