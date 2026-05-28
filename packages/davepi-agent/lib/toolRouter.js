'use strict';

const { z } = require('zod');

/**
 * Resource-first tool routing for backends with too many schemas.
 *
 * MCP tools from davepi are named with predictable prefixes:
 *   list_<resource>, get_<resource>, create_<resource>,
 *   update_<resource>, delete_<resource>, plus relation/aggregation/
 *   file tools that include the resource in their name.
 *
 * With more than `limit` tools (default 40), most LLMs start to
 * degrade — too many slots in the system message, weaker tool
 * picks. Instead of exposing them all every turn, we expose two
 * meta-tools:
 *
 *   - list_resources(): returns [{ name, description }]
 *   - use_resource(name): "narrows" the next turn's tool list to
 *     tools whose name contains the chosen resource. Implemented
 *     here as a context object the orchestrator reads on the next
 *     loop iteration.
 *
 * This is pure client-side — davepi doesn't change. The model gets
 * a clean two-step pattern ("which resource? → now use these tools")
 * that keeps any single turn's tool count small.
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

function buildRouterTools({ resources, state }) {
  return {
    list_resources: {
      description:
        'List the data resources (collections) available in this backend. Call this first ' +
        'when the user asks about data you don\'t yet have a tool for — it tells you which ' +
        'resource to dig into. Then call use_resource(name) to load that resource\'s tools.',
      parameters: z.object({}),
      async execute() {
        return {
          resources: resources.map((r) => ({
            name: r.resource,
            tool_count: r.tools.length,
          })),
        };
      },
    },
    use_resource: {
      description:
        'Switch focus to a specific resource. After calling this, your next turn will have ' +
        'the CRUD/relation/aggregation tools for that resource available. Call list_resources ' +
        'first if you are not sure which resource exists.',
      parameters: z.object({ name: z.string() }),
      async execute({ name }) {
        const match = resources.find((r) => r.resource === name);
        if (!match) {
          return { error: `Unknown resource: ${name}. Call list_resources to see what's available.` };
        }
        state.activeResource = name;
        return {
          resource: name,
          activated_tools: match.tools.map((t) => t.name),
        };
      },
    },
  };
}

function filterToolsForActiveResource(allTools, activeResource) {
  if (!activeResource) return [];
  return allTools.filter((t) => t.name.includes(activeResource));
}

module.exports = {
  deriveResources,
  shouldRoute,
  buildRouterTools,
  filterToolsForActiveResource,
};
