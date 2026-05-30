'use strict';

/**
 * davepi-plugin-skill-extractor
 *
 * The learning loop for `@davepi/agent` (docs/agent-learning-layer.md
 * §7, issue #132): good outcomes become draft skills automatically.
 *
 * Wiring, end to end:
 *
 *   1. A conversation is resolved (the agent or an operator transitions
 *      its `status` to `resolved`). The `conversation` schema's
 *      `onEnter.resolved` hook emits a `conversation.resolved` record
 *      event on the in-process bus, carrying the full transcript.
 *   2. This plugin subscribes to that event and hands the work to
 *      **davepi-plugin-queue** — extraction is slow + best-effort, so it
 *      runs off-thread and never blocks the response.
 *   3. The queue worker runs a **fresh** extraction agent over the
 *      transcript (`lib/agent.js`). Only when the approach was
 *      non-trivial AND the outcome positive does it propose a skill.
 *   4. The proposed skill is persisted as `status: draft`, tenant-scoped
 *      to the originating account. A human approves it via the #131
 *      state machine before it can ever reach the L0 prompt index.
 *
 * Dependencies and dormancy:
 *   - Hard-needs the `skill` schema (#131) and davepi-plugin-queue. List
 *     both before this plugin in `davepi.plugins`. If the queue is
 *     dormant (no `QUEUE_REDIS_URL`), this plugin logs a warning at boot
 *     and stays dormant too — `conversation.resolved` events are simply
 *     not acted on, never an error.
 *   - The LLM call is injectable. By default it uses the AI SDK +
 *     Anthropic (needs `ANTHROPIC_API_KEY`); a project can inject any
 *     `runExtraction` via `createPlugin`.
 */

const { extractSkill, DEFAULT_MIN_MESSAGES } = require('./lib/extract');
const { persistDraftSkill } = require('./lib/persist');
const { createDefaultExtraction } = require('./lib/agent');
const { NOOP_LOG } = require('./lib/logger');

const DEFAULT_JOB_NAME = 'skill.extract';
const RESOLVED_EVENT = 'conversation.resolved';
const SKILL_REGISTRY_KEY = 'v1/skill';
const CONVERSATION_REGISTRY_KEY = 'v1/conversation';

/**
 * Build a plugin instance.
 *
 * Options (all optional):
 *   - queue:         the davepi-plugin-queue instance to enqueue on /
 *                    register the handler with. Defaults to the shared
 *                    `require('davepi-plugin-queue')` singleton (the same
 *                    instance the consumer lists in `davepi.plugins`).
 *                    Inject a stub in tests.
 *   - runExtraction: the LLM call `({ system, transcript, messages,
 *                    agentKey }) => Promise<string>`. Defaults to a fresh
 *                    Anthropic call (`lib/agent.js`). Inject in tests.
 *   - getSkillModel: `() => MongooseModel` override. Defaults to looking
 *                    the `skill` model up off `schemaLoader`.
 *   - getConversationModel: `() => MongooseModel` override. Defaults to
 *                    looking the `conversation` model up off `schemaLoader`.
 *   - jobName:       queue job name (default `skill.extract`).
 *   - minMessages:   pre-filter — transcripts shorter than this skip
 *                    extraction entirely (default 4).
 *   - modelId:       model id for the default extraction agent.
 */
function createPlugin(opts = {}) {
  const jobName = opts.jobName || DEFAULT_JOB_NAME;
  const minMessages = Number.isFinite(opts.minMessages)
    ? opts.minMessages
    : DEFAULT_MIN_MESSAGES;
  const runExtraction = opts.runExtraction || createDefaultExtraction({ modelId: opts.modelId });

  const state = {
    queue: null,
    enabled: false,
    getModel: null,
    getConversationModel: null,
    log: null,
  };

  function resolveQueue() {
    if (opts.queue) return opts.queue;
    try {
      // The shared singleton the consumer configured from env. Same
      // instance whose bus listener + worker the framework wired.
      return require('davepi-plugin-queue');
    } catch (err) {
      return null;
    }
  }

  // The job handler: extract a skill from the transcript and persist a
  // draft. Runs in the queue worker, off the request thread.
  //
  // The transcript is re-read from the conversation record here rather
  // than carried on the job payload: the full JSON `history` grows
  // unbounded (it's the whole transcript, re-serialized every turn), so
  // putting it in the job would duplicate a large, ever-growing blob
  // into Redis on every resolution. The job carries only identifiers +
  // tenancy; the worker fetches the (already-persisted) transcript by id.
  async function handleExtractJob(data, ctx) {
    const log = (ctx && ctx.log) || state.log || NOOP_LOG;
    const agentKey = data && data.agentKey;
    const recordId = data && data.recordId;
    const userId = data && data.userId;

    const conversationModel = state.getConversationModel ? state.getConversationModel() : null;
    if (!conversationModel) {
      log.warn({ agentKey, recordId }, 'skill-extractor: no conversation model available; skipping');
      return { drafted: false };
    }
    let conversation;
    try {
      // Scope by userId (tenant) and exclude soft-deleted rows; a missing
      // `deletedAt` matches `null`, so this also covers the common case.
      conversation = await conversationModel
        .findOne({ _id: recordId, userId, deletedAt: null })
        .lean();
    } catch (err) {
      log.warn(
        { err: err && err.message, recordId },
        'skill-extractor: failed to load conversation; skipping'
      );
      return { drafted: false };
    }
    if (!conversation) {
      // Resolved row gone (deleted between resolution and extraction) —
      // best-effort, nothing to extract from.
      log.warn({ recordId }, 'skill-extractor: conversation not found; skipping');
      return { drafted: false };
    }

    const skill = await extractSkill({
      history: conversation.history,
      agentKey,
      runExtraction,
      minMessages,
      log,
    });
    if (!skill) {
      // Trivial / abandoned / model declined — the common case.
      return { drafted: false };
    }
    const model = state.getModel ? state.getModel() : null;
    const result = await persistDraftSkill({
      model,
      tenant: { userId, accountId: data && data.accountId },
      agentKey,
      skill,
      log,
    });
    return { drafted: Boolean(result.created), ...result };
  }

  // Bus subscriber: a resolved conversation → enqueue an extraction job.
  // Best-effort and fully decoupled from the request that resolved the
  // conversation, so it never blocks the response.
  function onRecord(event) {
    if (!event || event.type !== RESOLVED_EVENT) return;
    const log = state.log || NOOP_LOG;
    if (!state.enabled || !state.queue) return; // dormant: nothing to do
    const record = event.record || {};
    const userId = event.userId != null ? String(event.userId) : record.userId;
    if (!userId) {
      log.warn({ recordId: event.recordId }, 'skill-extractor: conversation.resolved without a tenant userId; skipping');
      return;
    }
    const accountId = record.accountId != null ? String(record.accountId) : userId;
    // Identifiers + tenancy only — never the transcript. The worker
    // re-reads `history` from the conversation record by id, so an
    // unbounded transcript is never copied into the Redis job payload.
    const data = {
      userId,
      accountId,
      agentKey: record.agentKey,
      recordId: event.recordId,
    };
    // Enqueue under the originating tenant so the queue's status route
    // (and any audit) stays correctly scoped.
    Promise.resolve(
      state.queue.enqueue(jobName, data, { user: { user_id: userId, accountId } })
    ).catch((err) => {
      log.error({ err: err && err.message, recordId: event.recordId }, 'skill-extractor: enqueue failed');
    });
  }

  async function setup({ schemaLoader, bus, log }) {
    state.log = log || NOOP_LOG;
    const modelFrom = (key) => () => {
      const entry = schemaLoader && schemaLoader.getEntry ? schemaLoader.getEntry(key) : null;
      return entry && entry.model ? entry.model : null;
    };
    state.getModel = opts.getSkillModel || modelFrom(SKILL_REGISTRY_KEY);
    state.getConversationModel =
      opts.getConversationModel || modelFrom(CONVERSATION_REGISTRY_KEY);

    const queue = resolveQueue();
    if (!queue || typeof queue.registerJob !== 'function') {
      state.log.warn(
        {},
        'skill-extractor: davepi-plugin-queue not available; learning loop is dormant'
      );
      return;
    }

    // Register the worker handler. registerJob throws when the queue is
    // dormant (no Redis) — degrade to dormant rather than failing boot,
    // so a project that hasn't wired Redis can still install this plugin.
    try {
      queue.registerJob(jobName, handleExtractJob);
      state.queue = queue;
      state.enabled = true;
    } catch (err) {
      state.log.warn(
        { err: err && err.message },
        'skill-extractor: could not register extraction job (queue dormant?); learning loop is dormant'
      );
      return;
    }

    if (bus && typeof bus.on === 'function') {
      bus.on('record', onRecord);
    }

    state.log.info({ jobName }, 'davepi-plugin-skill-extractor ready');
  }

  return {
    name: 'skill-extractor',
    setup,
    // Exposed for tests / advanced consumers.
    _handleExtractJob: handleExtractJob,
    _onRecord: onRecord,
    isEnabled: () => state.enabled,
  };
}

const defaultPlugin = createPlugin();
module.exports = defaultPlugin;
module.exports.createPlugin = createPlugin;
