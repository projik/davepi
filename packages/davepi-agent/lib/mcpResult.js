'use strict';

/**
 * Normalise an MCP tool result into a plain JS value.
 *
 * The davepi MCP server returns results in the standard MCP text-content
 * envelope; this unwraps the common shapes: a JSON text block parses to
 * its object, a plain text block becomes `{ text }`, and an error
 * envelope becomes `{ error: true, content: [...] }`. Lives in its own
 * module so both `orchestrator.js` and `conversation.js` can use it
 * without a circular require (orchestrator re-exports it for callers /
 * tests that import it from there).
 */
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

module.exports = { normalizeMcpResult };
