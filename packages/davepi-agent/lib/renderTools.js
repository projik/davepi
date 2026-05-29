'use strict';

const { z } = require('zod');

/**
 * Client-side synthetic tools the LLM can call to ask for a
 * structured render. These are not part of davepi's MCP surface —
 * they're injected into the tool list so the model has a
 * channel-neutral way to say "show this as a table" or "show this
 * as a chart". The channel adapter decides how to draw it:
 *
 *   HTTP/SSE → forward the structured payload as a `render` event
 *              so the browser-side client can choose its renderer.
 *   Slack    → render_table → Block Kit table block (or markdown
 *              fenced code block fallback for wide tables);
 *              render_chart → QuickChart image URL embedded as an
 *              image block.
 *
 * The model never gets to "send raw HTML/SVG" — that would let a
 * prompt-injected response inject markup. Both tools take strict
 * structured payloads validated by zod.
 */

const tableSchema = z.object({
  title: z.string().optional(),
  columns: z
    .array(
      z.union([
        z.string(),
        z.object({ key: z.string(), label: z.string().optional() }),
      ])
    )
    .min(1),
  rows: z.array(z.record(z.any())).max(500),
});

const chartSchema = z.object({
  title: z.string().optional(),
  vegaLiteSpec: z.record(z.any()),
});

function normalizeColumns(columns) {
  return columns.map((c) =>
    typeof c === 'string' ? { key: c, label: c } : { key: c.key, label: c.label || c.key }
  );
}

function buildRenderTools({ onRender } = {}) {
  const emit = async (payload) => {
    if (onRender) await onRender(payload);
    return payload;
  };

  return {
    render_table: {
      description:
        'Display a tabular result to the user. Use this whenever you have row-shaped data ' +
        'the user should see (lists, search results, summaries). Do NOT hand-write a markdown ' +
        'table in your text response when this tool is available — the channel adapter will ' +
        'render it more cleanly than markdown can.',
      parameters: tableSchema,
      async execute(input) {
        const cols = normalizeColumns(input.columns);
        return emit({
          type: 'table',
          title: input.title || null,
          columns: cols,
          rows: input.rows,
        });
      },
    },
    render_chart: {
      description:
        'Display a chart to the user using a Vega-Lite spec. The spec must be a valid ' +
        'Vega-Lite v5 object. Use this when the user asks for a visualization or when ' +
        'comparing magnitudes/trends makes sense. Keep specs simple: bar, line, area, point.',
      parameters: chartSchema,
      async execute(input) {
        return emit({
          type: 'chart',
          title: input.title || null,
          vegaLiteSpec: input.vegaLiteSpec,
        });
      },
    },
  };
}

module.exports = { buildRenderTools };
