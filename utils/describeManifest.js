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
    if (f.acl && (f.acl.read || f.acl.create || f.acl.update)) {
      entry.acl = {};
      if (Array.isArray(f.acl.read)) entry.acl.read = f.acl.read;
      if (Array.isArray(f.acl.create)) entry.acl.create = f.acl.create;
      if (Array.isArray(f.acl.update)) entry.acl.update = f.acl.update;
    }
    if (f.type === 'File' || (f.file && typeof f.file === 'object')) {
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

function describeAggregations(schema) {
  const aggs = schema.aggregations;
  if (!Array.isArray(aggs) || !aggs.length) return undefined;
  return aggs
    .filter((a) => a && typeof a.name === 'string')
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
        .filter((a) => a && typeof a.name === 'string')
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
  // GraphQL builder uses: `${path}${PascalCaseName}`.
  if (Array.isArray(schema.aggregations)) {
    for (const a of schema.aggregations) {
      if (a && typeof a.name === 'string') {
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
 */
function buildManifest({ schemaLoader, appName, version } = {}) {
  if (!schemaLoader) throw new Error('schemaLoader required');
  const schemas = {};
  for (const key of schemaLoader.listSchemas()) {
    const entry = schemaLoader.getEntry(key);
    if (!entry || !entry.schema) continue;
    schemas[entry.schema.path] = describeSchemaEntry(entry);
  }
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
      playground: 'GET /graphql/ (development only — gated on NODE_ENV !== production)',
    },
    schemas,
  };
}

module.exports = {
  buildManifest,
  describeFieldType,
};
