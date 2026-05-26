'use strict';

/**
 * RFC 6902 JSON-Patch `compare(before, after)`. Returns an array of
 * `{ op, path, value? }` ops describing how `before` would be
 * transformed into `after`.
 *
 * Delegates to `fast-json-patch.compare` for the actual diff — it's
 * the reference implementation of RFC 6902, has zero runtime deps of
 * its own, and gives us round-trip applicability for free (a consumer
 * can `applyPatch({}, diff)` to reconstruct `after` from `before`).
 * Issue #116 explicitly named `fast-json-patch` as the implementation
 * choice; a homegrown compare would diverge over time on edge cases
 * (array LCS, escape-sequence corners, no-op detection).
 *
 * Inputs may be `null` / `undefined`: the framework's bus emits
 * `before: null` on create and `after: null` on hard-delete, and
 * we coerce both sides to `{}` so the resulting patch is a per-key
 * `add` / `remove` series at the top level rather than a root-replace
 * — easier to render in an audit UI and easier to apply back through
 * `applyPatch({}, diff)`.
 */

const jsonpatch = require('fast-json-patch');

function compare(before, after) {
  const b = before === null || before === undefined ? {} : before;
  const a = after === null || after === undefined ? {} : after;
  return jsonpatch.compare(b, a);
}

module.exports = { compare };
