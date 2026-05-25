'use strict';

/**
 * Recursively scrub fields whose name appears in `fields`, replacing
 * the value with the literal string `[REDACTED]`. Operates on a fresh
 * copy — the input is never mutated, so the same snapshot can also be
 * passed to non-redacting consumers (the framework's in-tree audit,
 * future analytics consumers) without surprise.
 *
 * The match is case-insensitive on the *field name*. Values are
 * untouched apart from the redaction marker; we deliberately do NOT
 * try to redact things like "looks-like-a-credit-card" — that's pino
 * redaction's job and a different posture entirely.
 *
 * Arrays are walked element-by-element. Dates, Buffers, ObjectIds,
 * and other non-plain-object values pass through unchanged so the
 * audit row still serialises faithfully.
 */
function redact(value, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return value;
  const set = new Set(fields.map((f) => String(f).toLowerCase()));
  return walk(value, set);
}

function walk(value, set) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, set));
  }
  if (typeof value !== 'object') return value;
  // Preserve non-plain-object types — Date, Buffer, BSON ObjectId, etc.
  // Walking their properties would either produce nonsense or mutate
  // semantics (e.g., replacing Date.prototype.toISOString output with
  // a redacted string).
  if (
    value instanceof Date ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(value)) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (set.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = walk(v, set);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { redact };
