'use strict';

/**
 * Persist a proposed skill as a tenant-scoped `draft`.
 *
 * Writes go through the schema-generated `skill` Mongoose model. We
 * stamp `userId`/`accountId` from the *originating conversation's*
 * tenant (carried on the `conversation.resolved` event), never from the
 * worker's ambient identity — that's what keeps a proposed skill scoped
 * to the account whose conversation produced it. `status` is forced to
 * `draft` here too: the model write bypasses the REST/MCP create
 * pipeline (and thus `stampInitialStates`), so the worker has to assert
 * the governance contract itself — an extracted runbook is invisible to
 * the L0 prompt index until a human approves it (#131).
 *
 * Idempotency: skill names are unique per `(userId, agentKey, name)`. A
 * conversation can be resolved more than once, and similar conversations
 * can yield the same runbook name, so we skip rather than (a) crash on
 * the unique index or (b) clobber a skill an operator may have already
 * approved or edited. Re-extraction never resurfaces or overwrites an
 * existing skill. The `findOne` short-circuit handles the common case
 * cheaply; the create is additionally wrapped to treat the unique-index
 * violation (E11000) as the same benign "already exists" outcome, since
 * two extraction jobs can race between the lookup and the insert — a
 * duplicate must not turn into a failed/retried queue job.
 */

const { NOOP_LOG } = require('./logger');

async function persistDraftSkill({ model, tenant, agentKey, skill, log = NOOP_LOG }) {
  if (!model) {
    log.warn({ agentKey }, 'skill-extractor: no skill model available; cannot persist draft');
    return { created: false, reason: 'no-model' };
  }
  const userId = tenant && tenant.userId != null ? String(tenant.userId) : null;
  if (!userId) {
    log.warn(
      { agentKey },
      'skill-extractor: missing tenant userId; refusing to persist an unscoped skill'
    );
    return { created: false, reason: 'no-tenant' };
  }
  // accountId rides equal to the tenant userId by default — the skill
  // schema's owner-scoped composite index assumes accountId === userId.
  const accountId = tenant && tenant.accountId != null ? String(tenant.accountId) : userId;

  const existing = await model.findOne({ userId, agentKey, name: skill.name }).lean();
  if (existing) {
    log.info(
      { agentKey, name: skill.name, status: existing.status },
      'skill-extractor: a skill with this name already exists; skipping'
    );
    return { created: false, reason: 'exists', existingId: String(existing._id) };
  }

  let doc;
  try {
    doc = await model.create({
      userId,
      accountId,
      agentKey,
      name: skill.name,
      description: skill.description || '',
      body: skill.body,
      useCount: 0,
      status: 'draft',
    });
  } catch (err) {
    // A concurrent job inserted the same (userId, agentKey, name)
    // between our findOne and here. Mongo's unique index throws E11000;
    // that's the benign duplicate this function already means to skip,
    // not a failure to retry. Any other error propagates so the queue
    // can retry it with backoff.
    if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
      log.info(
        { agentKey, name: skill.name },
        'skill-extractor: concurrent insert of the same skill; skipping'
      );
      return { created: false, reason: 'exists' };
    }
    throw err;
  }
  log.info(
    { agentKey, name: skill.name, skillId: String(doc._id), userId },
    'skill-extractor: drafted a skill from a resolved conversation'
  );
  return { created: true, skillId: String(doc._id) };
}

module.exports = { persistDraftSkill };
