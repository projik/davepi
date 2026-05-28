/**
 * Role-based ACL helpers used by the schema-driven REST and GraphQL
 * surfaces.
 *
 * Schemas opt in to ACL by declaring two optional shapes:
 *
 *   field.acl = { read: [...], create: [...], update: [...] }
 *   schema.acl = { list: [...], delete: [...], scope: { role: filter } }
 *
 * `field.acl.read`   — only these roles see the field on responses;
 *                      everyone else gets the projection without it.
 * `field.acl.create` — only these roles may set the field on POST.
 *                      Other callers' values are dropped before insert.
 * `field.acl.update` — only these roles may set the field on PUT.
 *                      Other callers' values are dropped before update.
 *
 * `schema.acl.list`  — these roles BYPASS the userId scope on list /
 *                      findMany / count / connection / pagination.
 *                      Default behavior (caller sees their own records
 *                      only) still applies for everyone else.
 * `schema.acl.delete` — these roles BYPASS the userId scope on delete
 *                       and may remove records they don't own.
 * `schema.acl.scope`  — per-role MANDATORY filter that's `$and`-ed into
 *                       every read for that role. Use it to expose a
 *                       subset of a collection to a role that bypasses
 *                       the userId scope (e.g. an unauthenticated
 *                       storefront caller mapped via `X-Client-Id` to
 *                       a `storefront` role should only see published
 *                       products). The filter is server-controlled and
 *                       cannot be widened by a caller's own query.
 *
 * Schemas with no `acl` declarations behave exactly as they did before
 * this module landed: full ownership-based access for the authenticated
 * caller. The zero-config path is the common case.
 */

const hasOverlap = (rolesA, rolesB) => {
  if (!Array.isArray(rolesA) || !Array.isArray(rolesB)) return false;
  for (const r of rolesA) {
    if (rolesB.includes(r)) return true;
  }
  return false;
};

const userRoles = (user) => {
  if (!user) return [];
  return Array.isArray(user.roles) && user.roles.length ? user.roles : ['user'];
};

/**
 * Strip fields the caller's roles cannot read. Operates on plain
 * objects (e.g., result of `.lean()` or JSON.parse(JSON.stringify(doc))).
 */
function projectByAcl(record, schema, user) {
  if (!record || !schema || !Array.isArray(schema.fields)) return record;
  const roles = userRoles(user);
  const out = { ...record };
  for (const f of schema.fields) {
    const allowed = f.acl && f.acl.read;
    if (allowed && allowed.length && !hasOverlap(allowed, roles)) {
      delete out[f.name];
    }
  }
  return out;
}

function projectListByAcl(records, schema, user) {
  if (!Array.isArray(records)) return records;
  return records.map((r) => projectByAcl(r, schema, user));
}

/**
 * Fields the server controls itself (stamped from the JWT). Tenant
 * isolation depends on these never being writable from the client —
 * a request that changes `userId` would move the record into another
 * tenant's scope, and a request that changes `accountId` would
 * similarly break the (single-tenant) ownership contract.
 *
 * Exported so the schema loader / scope resolver can call
 * `stampTenantFields` and `stripTenantFields` at every persist site,
 * forming a defense-in-depth pair with `filterWritable`'s strip.
 */
const PROTECTED_WRITE_FIELDS = ['userId', 'accountId'];

/**
 * Drop fields from an inbound write payload that the caller's roles
 * cannot set for the given action ('create' | 'update'). Returns a
 * new shallow-copied object.
 *
 * Server-stamped tenant fields (`userId`, `accountId`) are always
 * stripped from inbound payloads — those values come from the JWT,
 * not the client, and the framework stamps them post-filter at every
 * persist site. Letting them through here would give a client (or a
 * malicious hook return value) a path to rewrite ownership.
 *
 * `type: 'File'` fields are framework-owned: clients write to them
 * via the dedicated multipart route, never via JSON CRUD. We drop
 * any client-supplied value here so a request body like
 * `{ attachment: { key: 'private/foo' } }` can't sneak in a
 * server-controlled key.
 */
function filterWritable(body, schema, user, action) {
  if (!body || !schema || !Array.isArray(schema.fields)) return body;
  const roles = userRoles(user);
  const out = {};
  const fieldByName = new Map(schema.fields.map((f) => [f.name, f]));
  for (const [k, v] of Object.entries(body)) {
    // Tenant ownership is server-controlled — never accept from the
    // wire. Stamping happens separately at the persist site.
    if (PROTECTED_WRITE_FIELDS.includes(k)) continue;
    const f = fieldByName.get(k);
    if (f && f.type === 'File') continue; // framework-owned
    // Computed / virtual fields are read-only — drop any
    // client-supplied value silently. The output attribute is
    // populated at response time by utils/computedFields.js.
    if (f && typeof f.computed === 'function') continue;
    const allowed = f && f.acl && f.acl[action];
    if (!allowed || !allowed.length || hasOverlap(allowed, roles)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Force tenant ownership fields onto a create-time payload. Called
 * at every pre-persist step on the create path, AFTER any hooks have
 * run, so a third-party hook (or schema-level code that returned a
 * rewritten payload) can't change ownership in its return value.
 * Mutates `target` and returns it for chaining convenience.
 */
function stampTenantFields(target, user) {
  if (!target || typeof target !== 'object') return target;
  const userId = user && user.user_id;
  if (!userId) return target;
  target.userId = userId;
  target.accountId = userId;
  return target;
}

/**
 * Remove tenant ownership fields from an update-time payload before
 * it reaches `$set`. The record being updated already has the right
 * `userId` / `accountId` (enforced by the ownership query that
 * scoped the update); writing them again is either a no-op (when
 * unchanged) or a tenant-rewrite attack (when a hook tried to
 * change them). Either way, the safe move is to never include them
 * in `$set`. Mutates `target` and returns it.
 */
function stripTenantFields(target) {
  if (!target || typeof target !== 'object') return target;
  for (const k of PROTECTED_WRITE_FIELDS) {
    delete target[k];
  }
  return target;
}

/**
 * Should the caller bypass the userId scope on list/findMany? True when
 * the schema declares acl.list AND the caller has one of those roles.
 */
function bypassUserScopeForList(schema, user) {
  const allowed = schema && schema.acl && schema.acl.list;
  if (!allowed || !allowed.length) return false;
  return hasOverlap(allowed, userRoles(user));
}

/**
 * Should the caller bypass the userId scope on delete? Same logic as
 * the list bypass but for the `delete` slot.
 */
function bypassUserScopeForDelete(schema, user) {
  const allowed = schema && schema.acl && schema.acl.delete;
  if (!allowed || !allowed.length) return false;
  return hasOverlap(allowed, userRoles(user));
}

/**
 * Check field-level read ACL on a single field. The standard
 * projection path (`projectByAcl`) is the preferred enforcement
 * site for stored fields, but TC-added GraphQL fields and computed
 * fields don't pass through it on the way to the wire — those
 * resolvers call this helper at resolve time instead.
 */
/**
 * Merge all per-role mandatory filters declared in `schema.acl.scope`
 * for the roles the caller actually holds. Returns `null` when no
 * applicable scope exists (so callers can skip the merge entirely),
 * a single filter object when one role matches, or an `$and` envelope
 * when multiple roles each declare a scope.
 *
 * A scope filter is a Mongo query fragment. It is server-controlled
 * and `$and`-ed into the request's effective filter AFTER the
 * caller's own query is parsed, so a public caller cannot widen the
 * server-imposed predicate.
 */
function getRoleScopeFilter(schema, user) {
  const scope = schema && schema.acl && schema.acl.scope;
  if (!scope || typeof scope !== 'object') return null;
  const roles = userRoles(user);
  const matched = [];
  for (const r of roles) {
    if (Object.prototype.hasOwnProperty.call(scope, r) && scope[r]) {
      matched.push(scope[r]);
    }
  }
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0];
  return { $and: matched };
}

/**
 * Merge a role-scope filter into an existing Mongo query object,
 * preserving any existing predicates. When the existing query
 * already contains an `$and`, the scope filter is appended; otherwise
 * the two are combined under a fresh `$and`. Returns a new object
 * (does not mutate `query`).
 */
function applyRoleScopeFilter(query, scopeFilter) {
  if (!scopeFilter) return query;
  if (!query || Object.keys(query).length === 0) return { ...scopeFilter };
  if (Array.isArray(query.$and)) {
    return { ...query, $and: [...query.$and, scopeFilter] };
  }
  return { $and: [query, scopeFilter] };
}

function canReadField(field, user) {
  if (!field || !field.acl || !Array.isArray(field.acl.read) || !field.acl.read.length) {
    return true;
  }
  return hasOverlap(field.acl.read, userRoles(user));
}

module.exports = {
  projectByAcl,
  projectListByAcl,
  filterWritable,
  bypassUserScopeForList,
  bypassUserScopeForDelete,
  userRoles,
  hasOverlap,
  canReadField,
  PROTECTED_WRITE_FIELDS,
  stampTenantFields,
  stripTenantFields,
  getRoleScopeFilter,
  applyRoleScopeFilter,
};
