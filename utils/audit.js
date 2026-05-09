const AuditLog = require('../model/auditLog');
const logger = require('./logger');

const FRAMEWORK_FIELDS = new Set([
  '_id',
  '__v',
  'createdAt',
  'updatedAt',
]);

/**
 * Compute a per-field diff between two plain-object snapshots. Keys
 * that exist on either side and have unequal stringified values land
 * in the diff as `[from, to]`. Framework metadata (_id, __v,
 * timestamps) is excluded because it always differs and never tells
 * the operator anything useful.
 */
function computeDiff(before, after) {
  const out = {};
  const keys = new Set([
    ...(before ? Object.keys(before) : []),
    ...(after ? Object.keys(after) : []),
  ]);
  for (const k of keys) {
    if (FRAMEWORK_FIELDS.has(k)) continue;
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out[k] = [a === undefined ? null : a, b === undefined ? null : b];
    }
  }
  return out;
}

const toPlain = (doc) => {
  if (!doc) return null;
  if (typeof doc.toObject === 'function') return doc.toObject();
  if (typeof doc.toJSON === 'function') return doc.toJSON();
  return JSON.parse(JSON.stringify(doc));
};

/**
 * Persist an audit entry. Errors are logged and swallowed: a failure
 * to write the audit row must not break the main operation.
 */
async function recordAudit({ req, resource, recordId, action, before, after }) {
  try {
    const userId = req && req.user && req.user.user_id;
    if (!userId || !resource || !recordId || !action) return;
    const plainBefore = toPlain(before);
    const plainAfter = toPlain(after);
    // Compute diff for every action — computeDiff naturally encodes
    // create as `null → value` and delete as `value → null`, which
    // matches the rest of the framework's "every mutation has a
    // diff" contract.
    const diff = computeDiff(plainBefore, plainAfter);
    await AuditLog.create({
      userId,
      resource,
      recordId,
      action,
      before: plainBefore,
      after: plainAfter,
      diff,
      reqId: req && req.id ? String(req.id) : null,
      ip: req && req.ip ? req.ip : null,
      userAgent: (req && req.get && req.get('user-agent')) || null,
    });
  } catch (err) {
    (req && req.log ? req.log : logger).error(
      { err },
      'recordAudit failed; not blocking the main operation'
    );
  }
}

module.exports = { recordAudit, computeDiff };
