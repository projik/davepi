/**
 * Role-based ACL helpers used by the schema-driven REST and GraphQL
 * surfaces.
 *
 * Schemas opt in to ACL by declaring two optional shapes:
 *
 *   field.acl = { read: [...], create: [...], update: [...] }
 *   schema.acl = { list: [...], delete: [...] }
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
 * Fields the server controls itself (stamped from the JWT) and that
 * ACL must never strip — even if a schema mistakenly declares an
 * `acl` block on them. Tenant isolation depends on these being
 * present in every write payload.
 */
const PROTECTED_WRITE_FIELDS = ['userId', 'accountId'];

/**
 * Drop fields from an inbound write payload that the caller's roles
 * cannot set for the given action ('create' | 'update'). Returns a
 * new shallow-copied object.
 *
 * Server-stamped fields (`userId`, `accountId`) are always kept,
 * regardless of any acl declared on them — those values come from
 * the JWT, not the client, and stripping them would either fail
 * insertion (required-field violation) or orphan the document.
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
    if (PROTECTED_WRITE_FIELDS.includes(k)) {
      out[k] = v;
      continue;
    }
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
};
