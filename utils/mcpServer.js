/**
 * MCP server generated from the live schema map.
 *
 * Walks the schema loader's registry and emits one MCP tool per CRUD
 * operation per schema, plus per-aggregation tools. Tool handlers
 * delegate to the same helpers REST uses (Mongoose models with
 * `userId`-scoped queries, ACL projection, soft-delete filters,
 * `runAggregation`) so behaviour is symmetric with the rest of the
 * surface — agents calling via MCP land in exactly the same code
 * paths as agents calling via HTTP.
 *
 * Two transports build on this module:
 *
 *   - HTTP: app.js mounts `/mcp` and constructs a server per request,
 *     binding `getUser` to `req.user` (set by the auth middleware).
 *     Stateless; no session bookkeeping.
 *
 *   - stdio: bin/davepi.js boots a long-lived server bound to a token
 *     supplied via `DAVEPI_TOKEN`, suitable for Claude Desktop /
 *     Claude Code's `.mcp.json`. Tool list is a snapshot at boot —
 *     schema hot-reload requires an MCP-server restart.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const mongoose = require('mongoose');

const {
  projectByAcl,
  projectListByAcl,
  filterWritable,
  bypassUserScopeForList,
  bypassUserScopeForDelete,
} = require('./acl');
const { normalizeRelations, parseIncludes, applyIncludes } = require('./relations');
const {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
} = require('./errors');

/**
 * Map a thrown error onto the canonical `{ code, message }` shape
 * the rest of the API exposes. Mirrors `middleware/errorHandler.js`
 * for Mongoose-specific cases so an MCP caller sees the same
 * VALIDATION / INVALID_ID / DUPLICATE codes a REST caller would.
 */
const formatError = (err) => {
  if (err instanceof mongoose.Error.ValidationError) {
    const message = Object.values(err.errors)
      .map((e) => e.message)
      .join('; ');
    return { code: 'VALIDATION', message };
  }
  if (err instanceof mongoose.Error.CastError) {
    return { code: 'INVALID_ID', message: `Invalid ${err.path}` };
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
    return { code: err.code || 'ERROR', message: err.message };
  }
  return null;
};

/**
 * Wrap an async handler and surface dAvePi's typed errors as MCP
 * `isError: true` results. Anything else propagates and the SDK
 * converts it to an internal error — matching the REST contract
 * where unknown errors reduce to "Internal server error".
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
 * (HTTP transport) or a midstream user change without re-creating the
 * server. Tools that require auth call this and throw
 * UnauthorizedError if it returns null.
 */
const requireUser = async (getUser) => {
  const user = await Promise.resolve(getUser ? getUser() : null);
  if (!user || !user.user_id) {
    throw new UnauthorizedError('Authentication required');
  }
  return user;
};

/**
 * Convert a parsed mongo querystring `filter` arg into the same
 * shape the REST list handler expects after running through
 * mongo-querystring. The MCP surface accepts the filter as a flat
 * object (`{ accountName: 'Acme', amount: { $gte: 100 } }`) — same
 * semantics, structured rather than serialised through query strings.
 */
const sanitizeFilter = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return JSON.parse(JSON.stringify(raw));
};

const PAGE_SIZE = () => parseInt(process.env.PAGE_SIZE || '20', 10);

/**
 * Register every schema's tools onto the McpServer. Pulled out of
 * `buildMcpServer` so tests can build a server and inspect the tool
 * list independently.
 */
function registerSchemaTools(server, entry, { schemaLoader, getUser }) {
  const s = entry.schema;
  const Model = entry.model;
  const path = s.path;
  const softDelete = s.softDelete !== false;
  const normalizedRelations = normalizeRelations(s);
  const relationNames = Object.keys(normalizedRelations);

  // Reusable arg shape pieces — keep them local to the closure so the
  // schema-specific descriptions reach the agent intact.
  const idArg = z.string().min(1).describe(`Document _id of the ${path} record`);
  const includeArg = z
    .array(z.enum([...(relationNames.length ? relationNames : ['__none__'])]))
    .optional()
    .describe(
      relationNames.length
        ? `Relations to populate in a single batched query per name. Allowed: ${relationNames.join(', ')}.`
        : 'No relations declared on this schema.'
    );

  // ---- list ---------------------------------------------------------
  server.registerTool(
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
        sort: z
          .string()
          .optional()
          .describe('field:asc | field:desc | score (text rank, requires q)'),
        q: z
          .string()
          .optional()
          .describe('Full-text search across `searchable` fields, if any'),
        include: includeArg,
        includeDeleted: z
          .boolean()
          .optional()
          .describe('When true, include soft-deleted tombstones'),
      },
    },
    handlerOf(async (args) => {
      const user = await requireUser(getUser);
      const pageSize = Math.min(args.perPage || PAGE_SIZE(), 200);
      const page = args.page || 1;
      const filter = sanitizeFilter(args.filter);
      if (!bypassUserScopeForList(s, user)) filter.userId = user.user_id;
      if (softDelete && !args.includeDeleted) filter.deletedAt = null;
      if (args.q && (s.fields || []).some((f) => f && f.searchable)) {
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
        Model.find(filter, projection)
          .sort(sortObject)
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .lean(),
        Model.find(filter).countDocuments(),
      ]);
      if (includes.length) {
        await applyIncludes(list, normalizedRelations, includes, {
          user,
          getResource: (p) => {
            for (const k of schemaLoader.listSchemas()) {
              const e = schemaLoader.getEntry(k);
              if (e && e.schema && e.schema.path === p) return e;
            }
            return null;
          },
        });
      }
      return {
        results: projectListByAcl(list, s, user),
        totalResults: count,
        page,
        perPage: pageSize,
      };
    })
  );

  // ---- get ----------------------------------------------------------
  server.registerTool(
    `get_${path}`,
    {
      title: `Get ${path} by id`,
      description: `Fetch a single ${path} record by _id.`,
      inputSchema: { id: idArg, include: includeArg },
    },
    handlerOf(async (args) => {
      const user = await requireUser(getUser);
      const baseQuery = bypassUserScopeForList(s, user)
        ? { _id: args.id }
        : { _id: args.id, userId: user.user_id };
      if (softDelete) baseQuery.deletedAt = null;
      const record = await Model.findOne(baseQuery).lean();
      if (!record) throw new NotFoundError(path);
      const includes = parseIncludes(args.include && args.include.join(','), normalizedRelations);
      if (includes.length) {
        await applyIncludes([record], normalizedRelations, includes, {
          user,
          getResource: (p) => {
            for (const k of schemaLoader.listSchemas()) {
              const e = schemaLoader.getEntry(k);
              if (e && e.schema && e.schema.path === p) return e;
            }
            return null;
          },
        });
      }
      return projectByAcl(record, s, user);
    })
  );

  // ---- create -------------------------------------------------------
  server.registerTool(
    `create_${path}`,
    {
      title: `Create ${path}`,
      description: `Create a new ${path} record. userId is stamped from the authenticated caller.`,
      inputSchema: {
        record: z.record(z.any()).describe(`A ${path} payload (see /api/v1/${path}-schema)`),
      },
    },
    handlerOf(async (args) => {
      const user = await requireUser(getUser);
      const writable = filterWritable(args.record || {}, s, user, 'create');
      const data = { ...writable, accountId: user.user_id, userId: user.user_id };
      const record = await Model.create(data);
      const plain = JSON.parse(JSON.stringify(record));
      return projectByAcl(plain, s, user);
    })
  );

  // ---- update -------------------------------------------------------
  server.registerTool(
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
      const filter = { _id: args.id, userId: user.user_id };
      if (softDelete) filter.deletedAt = null;
      const writable = filterWritable(args.record || {}, s, user, 'update');
      const result = await Model.updateOne(filter, { $set: writable });
      if (!result.matchedCount) throw new NotFoundError(path);
      const fresh = await Model.findOne({ _id: args.id }).lean();
      return projectByAcl(fresh, s, user);
    })
  );

  // ---- delete -------------------------------------------------------
  server.registerTool(
    `delete_${path}`,
    {
      title: `Delete ${path} by id`,
      description: softDelete
        ? `Soft-delete (deletedAt tombstone) a ${path} record. Use restore to bring it back.`
        : `Hard-delete a ${path} record.`,
      inputSchema: { id: idArg },
    },
    handlerOf(async (args) => {
      const user = await requireUser(getUser);
      const baseQuery = bypassUserScopeForDelete(s, user)
        ? { _id: args.id }
        : { _id: args.id, userId: user.user_id };
      if (softDelete) {
        const existing = await Model.findOne({ ...baseQuery, deletedAt: null }).lean();
        if (!existing) throw new NotFoundError(path);
        await Model.updateOne({ _id: existing._id }, { $set: { deletedAt: new Date() } });
        return { acknowledged: true, softDeleted: true, _id: String(existing._id) };
      }
      const result = await Model.deleteOne(baseQuery);
      if (!result.deletedCount) throw new NotFoundError(path);
      return { acknowledged: true, deletedCount: result.deletedCount };
    })
  );

  // ---- aggregations -------------------------------------------------
  for (const agg of (s.aggregations || [])) {
    if (!agg || typeof agg.name !== 'string' || !Array.isArray(agg.pipeline)) continue;
    const paramShape = {};
    for (const [pname, def] of Object.entries(agg.params || {})) {
      // Map declared param types to permissive zod scalars; runtime
      // casting (validateAndCastParams inside runAggregation) handles
      // the conversion to Date / ObjectId / number, so this only
      // documents the wire type.
      let z1;
      if (def.type === 'number') z1 = z.number();
      else if (def.type === 'boolean') z1 = z.boolean();
      else z1 = z.string();
      paramShape[pname] = def.required ? z1 : z1.optional();
    }
    server.registerTool(
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
    );
  }
}

/**
 * Build an McpServer wired against the given schema loader. `getUser`
 * is invoked lazily per tool call to obtain the authenticated user
 * — bind it to a request-scoped value (HTTP) or to a long-lived
 * env-bound user (stdio).
 */
function buildMcpServer({ schemaLoader, getUser, name = 'davepi', version = '1.0.0' }) {
  const server = new McpServer({ name, version });
  for (const key of schemaLoader.listSchemas()) {
    const entry = schemaLoader.getEntry(key);
    if (!entry || !entry.schema || !entry.model) continue;
    registerSchemaTools(server, entry, { schemaLoader, getUser });
  }
  return server;
}

/**
 * List every tool name the loader would emit, without instantiating
 * an actual McpServer. Useful for tests and `_describe`-style
 * introspection.
 */
function listToolNames(schemaLoader) {
  const names = [];
  for (const key of schemaLoader.listSchemas()) {
    const entry = schemaLoader.getEntry(key);
    if (!entry || !entry.schema) continue;
    const p = entry.schema.path;
    names.push(`list_${p}`, `get_${p}`, `create_${p}`, `update_${p}`, `delete_${p}`);
    for (const agg of entry.schema.aggregations || []) {
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
