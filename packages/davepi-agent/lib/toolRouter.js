'use strict';

const { z } = require('zod');

/**
 * Resource-first tool routing for backends with too many schemas.
 *
 * The earlier draft tried to dynamically swap the AI SDK's `tools`
 * argument mid-loop — which doesn't work, because `streamText`
 * captures the tools object once per call. The model would see an
 * empty MCP tool list (since `activeResource` starts null) and
 * never get the real CRUD tools even after calling `use_resource`.
 *
 * Reworked pattern: a stable meta-tool `call_mcp_tool({ name, args })`
 * is exposed at all times in routed mode. `use_resource(name)` flips
 * the router state's allowed-name predicate; `call_mcp_tool`
 * validates `name` against the predicate before forwarding to the
 * MCP client. This way the AI SDK only sees ~4 tools (list_resources,
 * use_resource, call_mcp_tool, plus render tools) instead of 150+,
 * AND the model can actually execute resource tools after picking
 * one.
 *
 * Tools are bucketed by parsing davepi's naming convention
 * (list_<resource>, get_<resource>, create_<resource>, etc.). This
 * is pure client-side — davepi doesn't change.
 */

function deriveResources(tools) {
  const byResource = new Map();
  for (const t of tools) {
    const m = t.name.match(/^(?:list|get|create|update|delete|restore|search|count|history|files)_(.+)$/);
    const resource = m ? m[1].replace(/^by_/, '') : null;
    if (!resource) continue;
    const bucket = byResource.get(resource) || { resource, tools: [] };
    bucket.tools.push(t);
    byResource.set(resource, bucket);
  }
  return Array.from(byResource.values());
}

function shouldRoute(toolCount, limit) {
  return toolCount > limit;
}

function filterToolsForActiveResource(allTools, activeResource) {
  if (!activeResource) return [];
  return allTools.filter((t) => t.name.includes(activeResource));
}

function buildRouterTools({ resources, state, mcpClient, channelCtx }) {
  const toolByName = new Map();
  for (const r of resources) {
    for (const t of r.tools) toolByName.set(t.name, { tool: t, resource: r.resource });
  }

  return {
    list_resources: {
      description:
        'List the data resources available in this backend. Call this first when you need ' +
        'to pick which resource to dig into. Then call use_resource(name) and finally ' +
        'call_mcp_tool({ name, args }) to invoke the resource\'s CRUD/relation/aggregation tools.',
      parameters: z.object({}),
      async execute() {
        return {
          resources: resources.map((r) => ({
            name: r.resource,
            tool_count: r.tools.length,
            tools: r.tools.map((t) => t.name),
          })),
        };
      },
    },
    use_resource: {
      description:
        'Switch focus to a specific resource. After calling this, call_mcp_tool will accept ' +
        'tool names that belong to this resource (e.g. list_<resource>, get_<resource>, etc.). ' +
        'Call list_resources first if you are not sure which resource exists.',
      parameters: z.object({ name: z.string() }),
      async execute({ name }) {
        const match = resources.find((r) => r.resource === name);
        if (!match) {
          return {
            error: `Unknown resource: ${name}. Call list_resources to see what's available.`,
          };
        }
        state.activeResource = name;
        return {
          resource: name,
          allowed_tools: match.tools.map((t) => t.name),
        };
      },
    },
    call_mcp_tool: {
      description:
        'Invoke a specific MCP tool by name with the given arguments. The tool name must ' +
        'belong to the currently active resource (set via use_resource). Inspect ' +
        'list_resources output for tool input shapes.',
      parameters: z.object({
        name: z.string(),
        args: z.record(z.any()).optional(),
      }),
      async execute({ name, args }) {
        if (!state.activeResource) {
          return {
            error: 'No resource is active. Call list_resources then use_resource(name) first.',
          };
        }
        const entry = toolByName.get(name);
        if (!entry || entry.resource !== state.activeResource) {
          return {
            error:
              `Tool "${name}" does not belong to the active resource ` +
              `"${state.activeResource}". Call use_resource to switch.`,
          };
        }
        const result = await mcpClient.callTool(name, args || {}, channelCtx);
        return normalizeMcpResult(result);
      },
    },
  };
}

function normalizeMcpResult(result) {
  if (!result) return { ok: true };
  if (result.isError) {
    return {
      error: true,
      content: result.content?.map((c) => c.text || c).filter(Boolean) ?? [],
    };
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    }
  }
  return result;
}

module.exports = {
  deriveResources,
  shouldRoute,
  buildRouterTools,
  filterToolsForActiveResource,
  normalizeMcpResult,
};
