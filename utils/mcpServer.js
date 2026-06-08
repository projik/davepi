/**
 * MCP server generated from the live schema map.
 *
 * Walks the schema loader's registry and emits MCP tools per schema:
 *   - CRUD: list, get, create, update, delete
 *   - Soft-delete: restore (when softDelete enabled)
 *   - Audit: history (when audit enabled)
 *   - Search: search (when any field is searchable)
 *   - Relations: list_<path>_<rel> (hasMany), get_<path>_<rel>
 *     (hasOne / belongsTo) — one tool per declared relation
 *   - Files: upload_<path>_<field>, fetch_<path>_<field>,
 *     delete_<path>_<field> per `type: 'File'` field (base64 wire)
 *   - Aggregations: aggregate_<path>_<name> per declared aggregation
 *
 * Tool handlers delegate to the same Mongoose models / helpers REST
 * uses (filterWritable, projectByAcl, applyIncludes, runAggregation,
 * the storage driver) so behaviour is symmetric: tenant isolation,
 * ACL projection, soft-delete filtering, and aggregation safety
 * rails apply identically.
 *
 * Two transports build on this module:
 *
 *   - HTTP: app.js mounts `/mcp` and constructs a server per request,
 *     binding `getUser` to `req.user` (set by the auth middleware).
 *     Stateless; no session bookkeeping.
 *
 *   - stdio: bin/davepi.js boots a long-lived server bound to a token
 *     supplied via `DAVEPI_TOKEN`. The CLI subscribes to schema
 *     changes (`schemaLoader.onChange`) and rebuilds the tool list
 *     on the existing connection so Claude Desktop / Code see new
 *     tools without restarting the process.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const mongoose = require('mongoose');
const crypto = require('crypto');

const {
  projectByAcl,
  projectListByAcl,
  filterWritable,
  bypassUserScopeForList,
  bypassUserScopeForDelete,
  bypassUserScopeForWrite,
  getRoleScopeFilter,
  applyRoleScopeFilter,
} = require('./acl');
const { normalizeRelations, parseIncludes, applyIncludes } = require('./relations');
const { matchAccept, decorateFileUrls } = require('./fileFields');
const { getStorageDriver } = require('./storage');
const { recordAudit } = require('./audit');
const { getHook, runBeforeHook, runAfterHook } = require('./hooks');
const logger = require('./logger');
const idempotency = require('./idempotency');
const AuditLog = require('../model/auditLog');
const {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  InvalidTransitionError,
} = require('./errors');
const {
  stateMachineFieldsOf,
  validateTransition,
  attachAvailableTransitions,
  stampInitialStates,
  listTransitionsToValidate,
} = require('./stateMachine');
const { emitRecordEvent } = require('./events');

/**
 * Map a thrown error onto the canonical `{ code, message, ... }`
 * shape the rest of the API exposes. Mirrors
 * `middleware/errorHandler.js` for Mongoose cases so an MCP caller
 * sees the same VALIDATION / INVALID_ID / DUPLICATE codes a REST
 * caller would, plus two MCP-specific annotations:
 *
 *   - `recoverable: true` on errors a well-behaved agent can fix by
 *     adjusting its arguments — VALIDATION (bad input) and
 *     INVALID_ID (malformed id). NOT_FOUND, DUPLICATE, FORBIDDEN are
 *     not retry-recoverable: the resource state is the problem, not
 *     the call shape. Lets MCP clients distinguish "fix the call and
 *     retry" from "this won't ever work."
 *
 *   - `auth: true` on UNAUTHORIZED so clients that handle credential
 *     refresh / re-prompting separately can detect an auth-level
 *     failure without parsing free-text. The SDK delivers all
 *     handler-thrown errors as tool-result `isError`, so we can't
 *     hand UNAUTHORIZED back as a transport-level JSON-RPC error
 *     — the structured payload is the carrier.
 */
const RECOVERABLE_CODES = new Set(['VALIDATION', 'INVALID_ID']);

const formatError = (err) => {
  if (err instanceof mongoose.Error.ValidationError) {
    const message = Object.values(err.errors)
      .map((e) => e.message)
      .join('; ');
    return { code: 'VALIDATION', message, recoverable: true };
  }
  if (err instanceof mongoose.Error.CastError) {
    return { code: 'INVALID_ID', message: `Invalid ${err.path}`, recoverable: true };
  }
  if (err && err.code === 11000) {
    const fields = Object.keys(err.keyValue || {});
    return {
      code: 'DUPLICATE',
      message: fields.length
        ? `Duplicate value for: ${fields.join(', ')}`
        : 'Duplicate key',
    };
  }
  if (err && err.isOperational) {
    const code = err.code || 'ERROR';
    const out = { code, message: err.message };
    if (RECOVERABLE_CODES.has(code)) out.recoverable = true;
    if (code === 'UNAUTHORIZED') out.auth = true;
    return out;
  }
  return null;
};

/**
 * Wrap an async handler and surface dAvePi's typed errors as MCP
 * `isError: true` tool results carrying a canonical
 * `{ code, message, recoverable?, auth? }` payload. Anything
 * unrecognised propagates and the SDK reduces it to an internal
 * error — same posture as the REST `errorHandler` in production.
 *
 * `structuredContent` is only set when the result is a plain object
 * — the MCP spec requires that field to be a record, so array
 * returns (lists, aggregations) get JSON in `content[0].text` only.
 */
const handlerOf = (run) => async (args, extra) => {
  try {
    const result = await run(args || {}, extra);
    const out = {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      out.structuredContent = result;
    }
    return out;
  } catch (err) {
    const formatted = formatError(err);
    if (!formatted) throw err;
    return {
      isError: true,
      content: [
        { type: 'text', text: JSON.stringify({ error: formatted }, null, 2) },
      ],
    };
  }
};

/**
 * Resolve the authenticated user for a tool call. `getUser` is called
 * fresh per invocation so the server can react to a token rotation
 * (HTTP transport) or a midstream user change without re-creating
 * the server.
 */
const requireUser = async (getUser) => {
  const user = await Promise.resolve(getUser ? getUser() : null);
  if (!user || !user.user_id) {
    throw new UnauthorizedError('Authentication required');
  }
  return user;
};

const sanitizeFilter = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return JSON.parse(JSON.stringify(raw));
};

const PAGE_SIZE = () => parseInt(process.env.PAGE_SIZE || '20', 10);

const TENANT_FIELDS = ['userId', 'accountId'];

/** Build a getResource fn over the live registry, kept inline so each
 *  tool sees the latest schema state during hot-reload. */
const makeGetResource = (schemaLoader) => (p) => {
  for (const k of schemaLoader.listSchemas()) {
    const e = schemaLoader.getEntry(k);
    if (e && e.schema && e.schema.path === p) return e;
  }
  return null;
};

/**
 * Register every tool a single schema produces. Returns the array of
 * `RegisteredTool` instances so the caller can `.remove()` them on
 * hot-reload.
 */
function registerSchemaTools(server, entry, { schemaLoader, getUser }) {
  const s = entry.schema;
  const Model = entry.model;
  const path = s.path;
  const softDelete = s.softDelete !== false;
  const auditEnabled = s.audit !== false;
  const normalizedRelations = normalizeRelations(s);
  const relationNames = Object.keys(normalizedRelations);
  const fileFields = (s.fields || []).filter((f) => f && f.type === 'File');
  const searchableFields = (s.fields || []).filter((f) => f && f.searchable);
  const registered = [];

  const idArg = z.string().min(1).describe(`Document _id of the ${path} record`);
  const includeArg = z
    .array(z.enum([...(relationNames.length ? relationNames : ['__none__'])]))
    .optional()
    .describe(
      relationNames.length
        ? `Relations to populate in a single batched query per name. Allowed: ${relationNames.join(', ')}.`
        : 'No relations declared on this schema.'
    );

  const populateInto = async (records, includes, user) => {
    if (!includes.length) return;
    await applyIncludes(records, normalizedRelations, includes, {
      user,
      getResource: makeGetResource(schemaLoader),
    });
  };

  // ---- list ---------------------------------------------------------
  registered.push(server.registerTool(
    `list_${path}`,
    {
      title: `List ${path}`,
      description:
        `Paginated list of ${path} records owned by the authenticated user. ` +
        'Filter is a flat object using mongo-querystring semantics ' +
        '({ field: value } or { field: { $gte: ... } }).',
      inputSchema: {
        filter: z.record(z.any()).optional().describe('Mongo-style filter object'),
        page: z.number().int().min(1).optional(),
        perPage: z.number().int().min(1).max(200).optional(),
        sort: z.string().optional().describe('field:asc | field:desc | score (text rank, requires q)'),
        q: z.string().optional().describe('Full-text search across `searchable` fields'),
        include: includeArg,
        includeDeleted: z.boolean().optional().describe('When true, include soft-deleted tombstones'),
      },
    },
    handlerOf(async (args) => {
      const user = await requireUser(getUser);
      const pageSize = Math.min(args.perPage || PAGE_SIZE(), 200);
      const page = args.page || 1;
      let filter = sanitizeFilter(args.filter);
      if (!bypassUserScopeForList(s, user)) filter.userId = user.user_id;
      // Apply schema.acl.scope[role] so MCP can't be used as an
      // alternate read surface that bypasses the mandatory filter
      // REST and GraphQL enforce.
      filter = applyRoleScopeFilter(filter, getRoleScopeFilter(s, user));
      if (softDelete && !args.includeDeleted) filter.deletedAt = null;
      if (args.q && searchableFields.length) {
        filter.$text = { $search: String(args.q) };
      }
      const sortObject = {};
      let projection;
      if (args.sort) {
        const [k, dir] = String(args.sort).split(':');
        if (k === 'score' && args.q) {
          sortObject.score = { $meta: 'textScore' };
          projection = { score: { $meta: 'textScore' } };
        } else if (k && k !== 'score') {
          sortObject[k] = dir;
        }
      }
      const includes = parseIncludes(args.include && args.include.join(','), normalizedRelations);
      const [list, count] = await Promise.all([
        Model.find(filter, projection).sort(sortObject).skip((page - 1) * pageSize).limit(pageSize).lean(),
        Model.find(filter).countDocuments(),
      ]);
      await populateInto(list, includes, user);
      attachAvailableTransitions(list, s, user);
      return {
        results: projectListByAcl(list, s, user),
        totalResults: count,
        page,
        perPage: pageSize,
      };
    })
  ));

  // ---- get ----------------------------------------------------------
  registered.push(server.registerTool(
    `get_${path}`,
    {
      title: `Get ${path} by id`,
      description: `Fetch a single ${path} record by _id.`,
      inputSchema: { id: idArg, include: includeArg },
    },
    handlerOf(async (args) => {
      const user = await requireUser(getUser);
      const ownerBase = bypassUserScopeForList(s, user)
        ? { _id: args.id }
        : { _id: args.id, userId: user.user_id };
      const baseQuery = applyRoleScopeFilter(
        ownerBase,
        getRoleScopeFilter(s, user)
      );
      if (softDelete) baseQuery.deletedAt = null;
      const record = await Model.findOne(baseQuery).lean();
      if (!record) throw new NotFoundError(path);
      const includes = parseIncludes(args.include && args.include.join(','), normalizedRelations);
      await populateInto([record], includes, user);
      attachAvailableTransitions([record], s, user);
      return projectByAcl(record, s, user);
    })
  ));

  // ---- create -------------------------------------------------------
  registered.push(server.registerTool(
    `create_${path}`,
    {
      title: `Create ${path}`,
      description:
        `Create a new ${path} record. userId is stamped from the authenticated caller. ` +
        'Pass `idempotencyKey` to make a retry safe — calling this tool twice with the ' +
        'same key + record returns the original result without creating a duplicate.',
      inputSchema: {
        record: z.record(z.any()).describe(`A ${path} payload (see /api/v1/${path}-schema)`),
        idempotencyKey: z.string().min(1).optional().describe(
          'Stable key for safe retry. Reusing the same key with a different ' +
          'record returns IDEMPOTENCY_CONFLICT.'
        ),
      },
    },
    handlerOf(async (args) => {
      const user = await requireUser(getUser);
      const writable = filterWritable(args.record || {}, s, user, 'create');
      // Stamp tenant fields AFTER filterWritable so any client-supplied
      // userId / accountId is overridden — never trust the wire for
      // ownership.
      const data = { ...writable, accountId: user.user_id, userId: user.user_id };
      // State-machine fields: stamp initial state. Same contract as
      // the REST POST handler — clients can't enter a record at any
      // state but the declared initial.
      stampInitialStates(data, s);

      // Idempotency: same claim-execute-complete protocol as the
      // REST middleware (utils/idempotency.js). Body hash covers
      // the writable shape post-filter so the same logical request
      // hashes the same way even if filterWritable strips an ACL'd
      // key.
      const idempotencyKey = args.idempotencyKey;
      const route = `mcp:create_${path}`;
      let bodyHash;
      let claimed = false;
      if (idempotencyKey) {
        bodyHash = idempotency.hashBody(data);
        const claim = await idempotency.claimIdempotency({
          key: idempotencyKey,
          userId: user.user_id,
          route,
          bodyHash,
        });
        if (claim.status === 'conflict') throw idempotency.conflictError();
        if (claim.status === 'in_progress') throw idempotency.inProgressError();
        if (claim.status === 'hit') {
          return { ...claim.record.body, _idempotent_replay: true };
        }
        claimed = true;
      }

      // Phase 1: the create itself. If this throws, the resource
      // doesn't exist; tear down the idempotency claim so the agent
      // can fix its payload and retry under the same key.
      let record;
      try {
        record = await Model.create(data);
      } catch (err) {
        if (claimed) {
          await idempotency.abandonIdempotency({
            key: idempotencyKey,
            userId: user.user_id,
            route,
          });
        }
        throw err;
      }

      // Phase 2: post-create bookkeeping. The resource now exists,
      // so we MUST return the projected record to the caller — a
      // failure to record an audit entry or persist the idempotency
      // outcome can't be allowed to mask the success. Both callees
      // are best-effort by design (they swallow errors internally
      // and log them), but we wrap defensively so any future change
      // in their failure semantics doesn't regress this contract.
      const plain = JSON.parse(JSON.stringify(record));
      attachAvailableTransitions([plain], s, user);
      const projected = projectByAcl(plain, s, user);
      if (auditEnabled) {
        try {
          await recordAudit({
            req: { user },
            resource: s.path,
            recordId: record._id,
            action: 'create',
            before: null,
            after: plain,
          });
        } catch (_) { /* best-effort */ }
      }
      if (claimed) {
        try {
          await idempotency.completeIdempotency({
            key: idempotencyKey,
            userId: user.user_id,
            route,
            status: 201,
            body: projected,
          });
        } catch (_) { /* best-effort */ }
      }
      return projected;
    })
  ));

  // ---- update -------------------------------------------------------
  registered.push(server.registerTool(
    `update_${path}`,
    {
      title: `Update ${path} by id`,
      description: `Apply a partial update to a ${path} record by _id.`,
      inputSchema: {
        id: idArg,
        record: z.record(z.any()).describe('Fields to set'),
      },
    },
    handlerOf(async (args) => {
      const user = await requireUser(getUser);
      // `acl.write` roles may update records they don't own (the
      // record's owner is preserved — tenant fields are stripped from
      // the $set below). Matches the REST PUT and GraphQL UpdateById
      // bypass.
      const filter = bypassUserScopeForWrite(s, user)
        ? { _id: args.id }
        : { _id: args.id, userId: user.user_id };
      if (softDelete) filter.deletedAt = null;
      const writable = filterWritable(args.record || {}, s, user, 'update');
      // filterWritable preserves PROTECTED_WRITE_FIELDS (userId,
      // accountId) so it can stay agnostic about who stamps them.
      // For updates, those values come from the JWT — strip any
      // client-supplied values so a tool call can't reassign
      // ownership of a record it owns.
      for (const f of TENANT_FIELDS) delete writable[f];
      // State-machine fields: same validation contract as REST PUT.
      // Need `before` for current-state lookup whenever audit is on
      // OR there's a state machine in play, so fetch once.
      const hasStateMachine = stateMachineFieldsOf(s).length > 0;
      const before = (auditEnabled || hasStateMachine)
        ? await Model.findOne(filter).lean()
        : null;
      const transitions = hasStateMachine
        ? listTransitionsToValidate(writable, before, s)
        : [];
      // 404 short-circuit: see schemaLoader's PUT handler — without
      // this, validateTransition would treat the absent `current`
      // as `initial_state_required` and surface a 400 instead of
      // the right NOT_FOUND.
      if (transitions.length && !before) {
        throw new NotFoundError(path);
      }
      for (const t of transitions) {
        const v = validateTransition(t.field, t.current, t.next);
        if (!v.valid) {
          throw new InvalidTransitionError(v.message, {
            field: t.field.name,
            current: v.current,
            attempted: v.attempted,
            allowed: v.allowed,
            reason: v.reason,
          });
        }
      }
      // Empty $set is a no-op in Mongoose (matchedCount=0 even when
      // the doc exists), so callers who post only ACL-stripped or
      // tenant-stripped keys would otherwise see a misleading 404.
      // Mirror the REST PUT contract: prove the doc exists first,
      // then short-circuit.
      if (Object.keys(writable).length === 0) {
        const exists = await Model.findOne(filter).select('_id').lean();
        if (!exists) throw new NotFoundError(path);
      } else {
        const result = await Model.updateOne(filter, { $set: writable });
        if (!result.matchedCount) throw new NotFoundError(path);
      }
      const fresh = await Model.findOne({ _id: args.id }).lean();
      if (auditEnabled && before) {
        await recordAudit({
          req: { user },
          resource: s.path,
          recordId: args.id,
          action: 'update',
          before,
          after: fresh,
        });
      }
      // Per-transition tail (matches REST PUT). Audit row,
      // dedicated event, optional onEnter — all best-effort.
      // The `updated` event also fires once for the operation as a
      // whole (matches both the REST PUT contract and the
      // standalone GraphQL transition mutation).
      if (transitions.length) {
        emitRecordEvent({
          type: `${path}.updated`,
          version: s.version,
          userId: user.user_id,
          recordId: String(args.id),
        });
      }
      for (const t of transitions) {
        if (auditEnabled) {
          try {
            await recordAudit({
              req: { user },
              resource: s.path,
              recordId: args.id,
              action: 'transition',
              before: { ...(before || {}), [t.field.name]: t.current },
              after: { ...(fresh || {}), [t.field.name]: t.next },
            });
          } catch (_) { /* best-effort */ }
        }
        emitRecordEvent({
          type: `${path}.transitioned`,
          version: s.version,
          userId: user.user_id,
          recordId: String(args.id),
          field: t.field.name,
          from: t.current,
          to: t.next,
        });
        const hook = (t.field.stateMachine.onEnter || {})[t.next];
        if (typeof hook === 'function') {
          try {
            await hook(fresh, { user, from: t.current, to: t.next });
          } catch (err) {
            logger.warn(
              { err, field: t.field.name, to: t.next },
              'state-machine onEnter hook threw; transition committed anyway'
            );
          }
        }
      }
      attachAvailableTransitions([fresh], s, user);
      return projectByAcl(fresh, s, user);
    })
  ));

  // ---- delete -------------------------------------------------------
  registered.push(server.registerTool(
    `delete_${path}`,
    {
      title: `Delete ${path} by id`,
      description: softDelete
        ? `Soft-delete (deletedAt tombstone) a ${path} record. Use restore_${path} to bring it back.`
        : `Hard-delete a ${path} record.`,
      inputSchema: { id: idArg },
    },
    handlerOf(async (args) => {
      const user = await requireUser(getUser);
      const baseQuery = bypassUserScopeForDelete(s, user)
        ? { _id: args.id }
        : { _id: args.id, userId: user.user_id };
      // Schema delete hooks govern this path too — without them an
      // `agent`-role caller could delete a record over MCP that
      // `beforeDelete` refuses over REST/GraphQL (e.g. the skill /
      // agentPersona guardrails, which rely on the hook because delete
      // has no field-level ACL). Mirror the REST/GraphQL contract:
      // beforeDelete gates (a throw rejects), afterDelete is best-effort.
      const hasBeforeDelete = !!getHook(s, 'beforeDelete');
      const hasAfterDelete = !!getHook(s, 'afterDelete');
      if (softDelete) {
        const existing = await Model.findOne({ ...baseQuery, deletedAt: null }).lean();
        if (!existing) throw new NotFoundError(path);
        await runBeforeHook(s, 'beforeDelete', { input: null, current: existing, user });
        const now = new Date();
        await Model.updateOne({ _id: existing._id }, { $set: { deletedAt: now } });
        const tombstoned = { ...existing, deletedAt: now };
        if (auditEnabled) {
          await recordAudit({
            req: { user },
            resource: s.path,
            recordId: existing._id,
            action: 'delete',
            before: existing,
            after: tombstoned,
          });
        }
        if (hasAfterDelete) {
          await runAfterHook(s, 'afterDelete', { record: tombstoned, user }, logger);
        }
        return { acknowledged: true, softDeleted: true, _id: String(existing._id) };
      }
      // Hard delete: load the record when audit OR either delete hook
      // needs it. A beforeDelete that gates on the record must see a
      // NOT_FOUND before any mutation, matching the REST path.
      const existing = (auditEnabled || hasBeforeDelete || hasAfterDelete)
        ? await Model.findOne(baseQuery).lean()
        : null;
      if (hasBeforeDelete) {
        if (!existing) throw new NotFoundError(path);
        await runBeforeHook(s, 'beforeDelete', { input: null, current: existing, user });
      }
      const result = await Model.deleteOne(baseQuery);
      if (!result.deletedCount) throw new NotFoundError(path);
      if (auditEnabled && existing) {
        await recordAudit({
          req: { user },
          resource: s.path,
          recordId: existing._id,
          action: 'delete',
          before: existing,
          after: null,
        });
      }
      if (hasAfterDelete) {
        await runAfterHook(s, 'afterDelete', { record: existing, user }, logger);
      }
      return { acknowledged: true, deletedCount: result.deletedCount };
    })
  ));

  // ---- restore (soft-delete only) -----------------------------------
  if (softDelete) {
    registered.push(server.registerTool(
      `restore_${path}`,
      {
        title: `Restore ${path} from soft-delete`,
        description: `Clear the deletedAt tombstone on a ${path} record so it becomes readable again.`,
        inputSchema: { id: idArg },
      },
      handlerOf(async (args) => {
        const user = await requireUser(getUser);
        const baseQuery = bypassUserScopeForDelete(s, user)
          ? { _id: args.id }
          : { _id: args.id, userId: user.user_id };
        const existing = await Model.findOne({ ...baseQuery, deletedAt: { $ne: null } }).lean();
        if (!existing) throw new NotFoundError(path);
        await Model.updateOne({ _id: existing._id }, { $set: { deletedAt: null } });
        if (auditEnabled) {
          await recordAudit({
            req: { user },
            resource: s.path,
            recordId: existing._id,
            action: 'restore',
            before: existing,
            after: { ...existing, deletedAt: null },
          });
        }
        return { acknowledged: true, restored: true, _id: String(existing._id) };
      })
    ));
  }

  // ---- history (audit only) -----------------------------------------
  if (auditEnabled) {
    registered.push(server.registerTool(
      `history_${path}`,
      {
        title: `Audit history for a ${path} record`,
        description: `Returns the audit log entries (create/update/delete/restore) for a ${path} by _id, newest first.`,
        inputSchema: {
          id: idArg,
          page: z.number().int().min(1).optional(),
          perPage: z.number().int().min(1).max(200).optional(),
        },
      },
      handlerOf(async (args) => {
        const user = await requireUser(getUser);
        // Match the REST contract: the caller must be able to read the
        // record (or carry the acl.list bypass) to see its history.
        // Role-scope predicate is applied on top so the history tool
        // can't be used as an alternate read surface for out-of-scope
        // records.
        const ownerBase = bypassUserScopeForList(s, user)
          ? { _id: args.id }
          : { _id: args.id, userId: user.user_id };
        const ownerQuery = applyRoleScopeFilter(
          ownerBase,
          getRoleScopeFilter(s, user)
        );
        const exists = await Model.findOne(ownerQuery).select('_id').lean();
        if (!exists) throw new NotFoundError(path);
        const pageSize = Math.min(args.perPage || PAGE_SIZE(), 200);
        const page = args.page || 1;
        const auditQuery = { resource: s.path, recordId: args.id };
        const [list, count] = await Promise.all([
          AuditLog.find(auditQuery).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
          AuditLog.countDocuments(auditQuery),
        ]);
        // Apply field-level read ACL to before/after/diff just like
        // the REST history route — otherwise gated fields would leak
        // through this side channel.
        const fieldByName = new Map((s.fields || []).map((f) => [f.name, f]));
        const userRolesArr = Array.isArray(user.roles) && user.roles.length ? user.roles : ['user'];
        const allowedDiffKey = (k) => {
          const f = fieldByName.get(k);
          if (!f || !f.acl || !f.acl.read) return true;
          return f.acl.read.some((r) => userRolesArr.includes(r));
        };
        const projected = list.map((entry) => ({
          ...entry,
          before: entry.before ? projectByAcl(entry.before, s, user) : entry.before,
          after: entry.after ? projectByAcl(entry.after, s, user) : entry.after,
          diff: entry.diff
            ? Object.fromEntries(Object.entries(entry.diff).filter(([k]) => allowedDiffKey(k)))
            : entry.diff,
        }));
        return { results: projected, totalResults: count, page, perPage: pageSize };
      })
    ));
  }

  // ---- search (any searchable field) --------------------------------
  if (searchableFields.length) {
    registered.push(server.registerTool(
      `search_${path}`,
      {
        title: `Full-text search over ${path}`,
        description: `Searches the framework-owned text index across these fields: ${searchableFields.map((f) => f.name).join(', ')}. Equivalent to list_${path} with sort=score.`,
        inputSchema: {
          q: z.string().min(1).describe('Search query'),
          page: z.number().int().min(1).optional(),
          perPage: z.number().int().min(1).max(200).optional(),
          sort: z.string().optional().describe('Defaults to score:desc'),
        },
      },
      handlerOf(async (args) => {
        const user = await requireUser(getUser);
        const pageSize = Math.min(args.perPage || PAGE_SIZE(), 200);
        const page = args.page || 1;
        const ownerFilter = bypassUserScopeForList(s, user) ? {} : { userId: user.user_id };
        const filter = applyRoleScopeFilter(ownerFilter, getRoleScopeFilter(s, user));
        if (softDelete) filter.deletedAt = null;
        filter.$text = { $search: String(args.q) };
        const sortObject = { score: { $meta: 'textScore' } };
        const projection = { score: { $meta: 'textScore' } };
        if (args.sort) {
          const [k, dir] = String(args.sort).split(':');
          if (k && k !== 'score') {
            sortObject[k] = dir;
          }
        }
        const [list, count] = await Promise.all([
          Model.find(filter, projection).sort(sortObject).skip((page - 1) * pageSize).limit(pageSize).lean(),
          Model.find(filter).countDocuments(),
        ]);
        return {
          results: projectListByAcl(list, s, user),
          totalResults: count,
          page,
          perPage: pageSize,
        };
      })
    ));
  }

  // ---- per-relation navigation tools --------------------------------
  for (const [relName, def] of Object.entries(normalizedRelations)) {
    if (def.kind === 'hasMany') {
      registered.push(server.registerTool(
        `list_${path}_${relName}`,
        {
          title: `List ${path}.${relName}`,
          description: `Returns the ${path} record's ${relName} (${def.kind} → ${def.target}) in a single batched query, scoped to the authenticated user.`,
          inputSchema: { id: idArg },
        },
        handlerOf(async (args) => {
          const user = await requireUser(getUser);
          const ownerBase = bypassUserScopeForList(s, user)
            ? { _id: args.id }
            : { _id: args.id, userId: user.user_id };
          const baseQuery = applyRoleScopeFilter(
            ownerBase,
            getRoleScopeFilter(s, user)
          );
          const parent = await Model.findOne(baseQuery).select('_id').lean();
          if (!parent) throw new NotFoundError(path);
          const wrapper = [{ _id: parent._id }];
          await applyIncludes(wrapper, normalizedRelations, [relName], {
            user,
            getResource: makeGetResource(schemaLoader),
          });
          return wrapper[0][relName] || [];
        })
      ));
    } else {
      // hasOne or belongsTo — single populated record (or null).
      registered.push(server.registerTool(
        `get_${path}_${relName}`,
        {
          title: `Get ${path}.${relName}`,
          description: `Returns the ${relName} (${def.kind} → ${def.target}) for a ${path} record. null when no match.`,
          inputSchema: { id: idArg },
        },
        handlerOf(async (args) => {
          const user = await requireUser(getUser);
          const ownerBase = bypassUserScopeForList(s, user)
            ? { _id: args.id }
            : { _id: args.id, userId: user.user_id };
          const baseQuery = applyRoleScopeFilter(
            ownerBase,
            getRoleScopeFilter(s, user)
          );
          // belongsTo joins on a localKey field on the parent; fetch
          // it (not just _id) so applyIncludes can read the join key.
          const projection =
            def.kind === 'belongsTo' ? { _id: 1, [def.localKey]: 1 } : { _id: 1 };
          const parent = await Model.findOne(baseQuery, projection).lean();
          if (!parent) throw new NotFoundError(path);
          const wrapper = [parent];
          await applyIncludes(wrapper, normalizedRelations, [relName], {
            user,
            getResource: makeGetResource(schemaLoader),
          });
          return wrapper[0][relName] || null;
        })
      ));
    }
  }

  // ---- file fields (per type: 'File') -------------------------------
  for (const f of fileFields) {
    const cfg = f.file || {};
    const maxBytes = cfg.maxBytes || 10 * 1024 * 1024;
    const accept = Array.isArray(cfg.accept) ? cfg.accept : null;
    const access = cfg.access || 'public';

    // upload: base64 wire so binary blobs travel through JSON-RPC.
    registered.push(server.registerTool(
      `upload_${path}_${f.name}`,
      {
        title: `Upload ${path}.${f.name}`,
        description:
          `Upload a file to the ${f.name} field of a ${path} record (base64 transport). ` +
          `maxBytes: ${maxBytes}` +
          (accept ? `; accept: ${accept.join(', ')}` : '') +
          `; access: ${access}.`,
        inputSchema: {
          id: idArg,
          base64: z.string().min(1).describe('Base64-encoded file body'),
          filename: z.string().min(1),
          mimeType: z.string().min(1),
        },
      },
      handlerOf(async (args) => {
        const user = await requireUser(getUser);
        const buffer = Buffer.from(args.base64, 'base64');
        if (buffer.length > maxBytes) {
          throw new ValidationError(`File exceeds ${maxBytes} bytes`);
        }
        if (accept && !matchAccept(args.mimeType, accept)) {
          throw new ValidationError(`File type ${args.mimeType} not allowed for ${f.name}`);
        }
        const baseOwner = bypassUserScopeForList(s, user)
          ? { _id: args.id }
          : { _id: args.id, userId: user.user_id };
        const ownerQuery = softDelete ? { ...baseOwner, deletedAt: null } : baseOwner;
        const record = await Model.findOne(ownerQuery);
        if (!record) throw new NotFoundError(path);

        const safeName = String(args.filename).replace(/[^A-Za-z0-9._-]+/g, '_');
        const accessPrefix = access === 'private' ? 'private' : 'public';
        const key = `${accessPrefix}/${path}/${record._id}/${f.name}/${crypto.randomUUID()}-${safeName}`;
        const storage = getStorageDriver();
        await storage.put(key, buffer, { contentType: args.mimeType });

        const meta = {
          key,
          bucket: storage.bucket || null,
          size: buffer.length,
          contentType: args.mimeType,
          originalName: args.filename,
          uploadedAt: new Date(),
        };
        const previous = record.get(f.name);
        record.set(f.name, meta);
        try {
          await record.save();
        } catch (saveErr) {
          // Compensate: remove the orphan blob on save failure.
          try { await storage.remove(key); } catch (_) {}
          throw saveErr;
        }
        if (previous && previous.key && previous.key !== key) {
          try { await storage.remove(previous.key); } catch (_) {}
        }
        const decorated = await decorateFileUrls(JSON.parse(JSON.stringify(record)), s, storage);
        return decorated[f.name];
      })
    ));

    // fetch: returns the URL (public or signed) — same posture as the
    // REST 302 redirect.
    registered.push(server.registerTool(
      `fetch_${path}_${f.name}`,
      {
        title: `Fetch URL for ${path}.${f.name}`,
        description: `Returns the ${access === 'private' ? 'short-lived signed' : 'public'} URL for the ${f.name} blob.`,
        inputSchema: { id: idArg },
      },
      handlerOf(async (args) => {
        const user = await requireUser(getUser);
        const baseOwner = bypassUserScopeForList(s, user)
          ? { _id: args.id }
          : { _id: args.id, userId: user.user_id };
        const scopedOwner = applyRoleScopeFilter(
          baseOwner,
          getRoleScopeFilter(s, user)
        );
        const ownerQuery = softDelete ? { ...scopedOwner, deletedAt: null } : scopedOwner;
        const record = await Model.findOne(ownerQuery).lean();
        if (!record) throw new NotFoundError(path);
        const meta = record[f.name];
        if (!meta || !meta.key) throw new NotFoundError(`${path}.${f.name}`);
        const storage = getStorageDriver();
        const url = access === 'private' ? await storage.signedUrl(meta.key) : storage.publicUrl(meta.key);
        return { url, meta };
      })
    ));

    // delete: clear the blob and the metadata sub-doc.
    registered.push(server.registerTool(
      `delete_${path}_${f.name}`,
      {
        title: `Delete ${path}.${f.name}`,
        description: `Remove the ${f.name} blob and clear the metadata on the record.`,
        inputSchema: { id: idArg },
      },
      handlerOf(async (args) => {
        const user = await requireUser(getUser);
        const baseOwner = bypassUserScopeForDelete(s, user)
          ? { _id: args.id }
          : { _id: args.id, userId: user.user_id };
        const ownerQuery = softDelete ? { ...baseOwner, deletedAt: null } : baseOwner;
        const record = await Model.findOne(ownerQuery);
        if (!record) throw new NotFoundError(path);
        const meta = record.get(f.name);
        if (!meta || !meta.key) {
          return { acknowledged: true, alreadyEmpty: true };
        }
        const storage = getStorageDriver();
        try { await storage.remove(meta.key); } catch (_) {}
        record.set(f.name, null);
        await record.save();
        return { acknowledged: true };
      })
    ));
  }

  // ---- aggregations -------------------------------------------------
  for (const agg of (s.aggregations || [])) {
    if (!agg || typeof agg.name !== 'string' || !Array.isArray(agg.pipeline)) continue;
    const paramShape = {};
    for (const [pname, def] of Object.entries(agg.params || {})) {
      let z1;
      if (def.type === 'number') z1 = z.number();
      else if (def.type === 'boolean') z1 = z.boolean();
      else z1 = z.string();
      paramShape[pname] = def.required ? z1 : z1.optional();
    }
    registered.push(server.registerTool(
      `aggregate_${path}_${agg.name}`,
      {
        title: agg.description || `${path} aggregation: ${agg.name}`,
        description:
          agg.description ||
          `Run the declared "${agg.name}" aggregation on ${path}. ` +
            'Tenant isolation: $match: { userId } is prepended automatically.',
        inputSchema: paramShape,
      },
      handlerOf(async (args) => {
        const user = await requireUser(getUser);
        const result = await schemaLoader.runAggregation({
          agg,
          schema: s,
          model: Model,
          user,
          rawParams: args || {},
        });
        return result.data;
      })
    ));
  }

  return registered;
}

/**
 * Build an McpServer wired against the given schema loader. `getUser`
 * is invoked lazily per tool call to obtain the authenticated user
 * — bind it to a request-scoped value (HTTP) or to a long-lived
 * env-bound user (stdio).
 *
 * If `liveReload` is true and the schemaLoader exposes `onChange`,
 * the server re-registers tools whenever a schema is loaded /
 * unloaded and emits a `tools/list_changed` notification so a
 * connected client refreshes its tool registry without reconnecting.
 */
function buildMcpServer({
  schemaLoader,
  getUser,
  name = 'davepi',
  version = '1.0.0',
  liveReload = false,
}) {
  const server = new McpServer({ name, version });
  // Map<schemaKey, RegisteredTool[]> so hot-reload can `.remove()`
  // the previous generation cleanly before re-registering.
  const registeredByKey = new Map();

  const buildAll = () => {
    for (const key of schemaLoader.listSchemas()) {
      const entry = schemaLoader.getEntry(key);
      if (!entry || !entry.schema || !entry.model) continue;
      registeredByKey.set(
        key,
        registerSchemaTools(server, entry, { schemaLoader, getUser })
      );
    }
  };

  const rebuildAll = () => {
    for (const list of registeredByKey.values()) {
      for (const t of list) {
        try { t.remove(); } catch (_) {}
      }
    }
    registeredByKey.clear();
    buildAll();
    // Notify any connected client to re-fetch its tool list.
    try { server.sendToolListChanged(); } catch (_) {}
  };

  buildAll();

  if (liveReload && typeof schemaLoader.onChange === 'function') {
    const unsub = schemaLoader.onChange(() => {
      rebuildAll();
    });
    // Stash on the McpServer so callers can detach if they recreate
    // the server.
    server._unsubscribeSchemaChanges = unsub;
  }

  return server;
}

/**
 * List every tool name the loader would emit, without instantiating
 * an actual McpServer. Used for tests and `_describe`-style
 * introspection.
 */
function listToolNames(schemaLoader) {
  const names = [];
  for (const key of schemaLoader.listSchemas()) {
    const entry = schemaLoader.getEntry(key);
    if (!entry || !entry.schema) continue;
    const s = entry.schema;
    const p = s.path;
    names.push(`list_${p}`, `get_${p}`, `create_${p}`, `update_${p}`, `delete_${p}`);
    if (s.softDelete !== false) names.push(`restore_${p}`);
    if (s.audit !== false) names.push(`history_${p}`);
    if ((s.fields || []).some((f) => f && f.searchable)) names.push(`search_${p}`);
    for (const [relName, def] of Object.entries(normalizeRelations(s))) {
      names.push(def.kind === 'hasMany' ? `list_${p}_${relName}` : `get_${p}_${relName}`);
    }
    for (const f of (s.fields || []).filter((x) => x && x.type === 'File')) {
      names.push(`upload_${p}_${f.name}`, `fetch_${p}_${f.name}`, `delete_${p}_${f.name}`);
    }
    for (const agg of s.aggregations || []) {
      if (agg && typeof agg.name === 'string' && Array.isArray(agg.pipeline)) {
        names.push(`aggregate_${p}_${agg.name}`);
      }
    }
  }
  return names;
}

module.exports = {
  buildMcpServer,
  registerSchemaTools,
  listToolNames,
};
