'use strict';

/**
 * Minimal RFC 6902 JSON-Patch `compare(before, after)`. Returns an
 * array of `{ op, path, value? }` ops describing how `before` would be
 * transformed into `after`.
 *
 * Kept in-package (rather than depending on `fast-json-patch`) so the
 * plugin retains the zero-runtime-dependency posture of the other
 * first-party dAvePi plugins. We do not need the full RFC surface —
 * audit consumers want a stable, structurally-valid patch for "what
 * changed" rendering, not the ability to apply the patch back. The
 * supported subset:
 *
 *   - top-level keys are walked recursively for plain objects
 *   - arrays and primitives are treated as opaque values (whole
 *     `replace`) so we don't try to LCS-diff arrays — that's where
 *     `fast-json-patch` earns its complexity, and most audit diffs in
 *     practice are scalar field changes anyway
 *   - `~` is encoded as `~0` and `/` as `~1` per RFC 6901 (JSON Pointer)
 *   - top-level `compare(null, obj)` emits `add` ops per key, and
 *     `compare(obj, null)` emits `remove` ops per key — matches how
 *     `fast-json-patch.compare({}, after)` behaves, so a consumer can
 *     round-trip-apply via `fast-json-patch.applyPatch({}, diff)` if
 *     they install that package separately.
 */

function escape(key) {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

function isPlainObject(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  // Cheap structural equality is enough for our needs — `before` /
  // `after` are JSON-shaped snapshots straight off Mongoose's
  // `.lean()` / `JSON.parse(JSON.stringify(...))`. JSON.stringify
  // ordering is stable per V8 / engine convention; if two snapshots
  // serialise identically they're equal for diff purposes.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_e) {
    return false;
  }
}

function diffObjects(before, after, basePath) {
  const ops = [];
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  for (const k of keys) {
    const path = `${basePath}/${escape(k)}`;
    const bHas = before && Object.prototype.hasOwnProperty.call(before, k);
    const aHas = after && Object.prototype.hasOwnProperty.call(after, k);
    const b = bHas ? before[k] : undefined;
    const a = aHas ? after[k] : undefined;
    if (bHas && !aHas) {
      ops.push({ op: 'remove', path });
    } else if (!bHas && aHas) {
      ops.push({ op: 'add', path, value: a });
    } else if (isPlainObject(b) && isPlainObject(a)) {
      ops.push(...diffObjects(b, a, path));
    } else if (!deepEqual(b, a)) {
      ops.push({ op: 'replace', path, value: a });
    }
  }
  return ops;
}

function compare(before, after) {
  // Top-level null/undefined: emit per-key add / remove ops rather
  // than a single root-level op. JSON-Patch with an empty path is
  // legal but harder to render — "field X added" is more useful than
  // "the entire document was added".
  const beforeIsNull = before === null || before === undefined;
  const afterIsNull = after === null || after === undefined;
  if (beforeIsNull && afterIsNull) return [];
  if (beforeIsNull && isPlainObject(after)) {
    return Object.keys(after).map((k) => ({
      op: 'add',
      path: `/${escape(k)}`,
      value: after[k],
    }));
  }
  if (afterIsNull && isPlainObject(before)) {
    return Object.keys(before).map((k) => ({
      op: 'remove',
      path: `/${escape(k)}`,
    }));
  }
  if (!isPlainObject(before) || !isPlainObject(after)) {
    // Two non-object snapshots: emit a single root replace if they
    // differ. The audit plugin always passes plain-object snapshots in
    // practice; this is the defensive fallback.
    if (deepEqual(before, after)) return [];
    return [{ op: 'replace', path: '', value: after }];
  }
  return diffObjects(before, after, '');
}

module.exports = { compare, escape };
