'use strict';

const logger = require('./logger');
const { runTurn } = require('./orchestrator');
const { normalizeMcpResult } = require('./mcpResult');
const { renderEventToBlocks, createSlackPoster } = require('./channels/slack');

/**
 * Proactive / scheduled agents — workstream E of the learning layer
 * (docs/agent-learning-layer.md §8).
 *
 * Hermes runs cron jobs that load a named skill and act without a human
 * prompting them (follow-ups, SLA digests). We port that to davepi, but
 * the skill is a **governed, tenant-scoped record**, not a JSON file in
 * `~/.hermes/cron`:
 *
 *   - A scheduled job (registered with `davepi-plugin-cron`) loads one
 *     named `skill` plus the agent's persona and runs a **fresh**
 *     `runTurn` — empty history, no end-user, so the persona shapes tone
 *     and the skill body is the task.
 *   - The skill is read through the agent's own MCP identity via the
 *     schema-generated `list_skill` tool, filtered to `status: 'approved'`.
 *     Tenant isolation is the hard floor: the agent's service auth owns
 *     exactly one tenant's data, so the run — and the skill it loads — is
 *     tenant-scoped server-side, exactly like every other read. For a
 *     multi-tenant deployment, register one job per tenant agent.
 *   - Output posts to Slack via the existing channel adapter's block
 *     rendering, so a scheduled digest looks like any other agent reply.
 *
 * Governance carries over for free: because only `approved` skills are
 * loadable here, a half-baked self-authored runbook can never be fired by
 * a cron job until a human signs off (skill.js state machine + field ACL).
 */

const PROACTIVE_CHANNEL = 'cron';

/**
 * Default trigger preamble prepended to the skill body. It frames the
 * turn as autonomous (no human is waiting) and asks the model to follow
 * the runbook and emit the report directly, since a scheduled run has no
 * back-and-forth.
 */
const DEFAULT_TRIGGER = [
  'You are running as a scheduled job. No human is in this conversation, so',
  'there will be no follow-up — gather what you need with your tools and',
  'produce the complete output the runbook below calls for in a single reply.',
  'Use the render tools for tables/charts where the runbook asks for them.',
].join(' ');

/**
 * Load a single `approved` skill by name through the agent's MCP identity.
 * Returns the full row (including `body`) or `null` when there's no
 * matching approved skill — the same server-side `status: 'approved'`
 * filter the prompt's L0 index uses, so a draft/deprecated runbook is
 * never fired by a cron job.
 *
 * `name` matches the `skill.name` field; `agentKey` scopes it to this
 * agent. The `(userId, agentKey, name)` composite index makes the match
 * unique per tenant agent.
 */
async function loadSkillByName({ mcpClient, channelCtx, agentKey, name }) {
  if (!name) return null;
  const raw = await mcpClient.callTool(
    'list_skill',
    { filter: { agentKey, name, status: 'approved' }, perPage: 1 },
    channelCtx
  );
  const norm = normalizeMcpResult(raw);
  if (!norm || norm.error) return null;
  const rows = norm.results || norm.records || [];
  return Array.isArray(rows) ? rows[0] || null : null;
}

/**
 * Build the autonomous trigger message from the loaded skill. The
 * operator-approved `body` (L1) is inlined directly as the task rather
 * than left for the model to fetch via `get_skill`: an attached-skill
 * cron job exists to run *this* runbook, so we don't make it optional.
 */
function buildTriggerMessage({ skill, prompt }) {
  const preamble = prompt || DEFAULT_TRIGGER;
  const parts = [preamble, '', `# Runbook: ${skill.name}`];
  if (skill.description) parts.push(skill.description);
  if (skill.body) parts.push('', skill.body);
  return parts.join('\n');
}

/**
 * Run one scheduled skill turn. Loads the named `approved` skill, builds
 * the trigger message, and drives a fresh `runTurn` (empty history) under
 * a `cron` channel context — no `channelUserId`, so no customer profile
 * and no per-conversation persistence: every scheduled run is independent.
 * The persona (slot #1) still loads because `config.agent.key` is set.
 *
 * Returns `{ text, history, skill, renderBlocks }`. Throws `SkillNotFound`
 * when no approved skill matches `skill` (the caller decides whether a
 * missing runbook is fatal for that job).
 */
async function runScheduledSkill({
  config,
  model,
  mcpClient,
  skill: skillName,
  prompt,
  channelCtx,
  onEvent = () => {},
  log = logger,
  // Cooperative-cancellation signal from the cron lease. Checked at each
  // boundary (before the skill lookup, before and after the turn) and
  // forwarded to `runTurn` so MCP tool calls and model generation stop
  // when the lease is lost — the agent must not keep writing after another
  // node has taken over.
  signal,
  // Test seam: override the orchestrator entrypoint so the handler can be
  // exercised without a live model / `ai` SDK.
  _runTurn = runTurn,
}) {
  const agentKey = config && config.agent && config.agent.key;
  if (!agentKey) {
    throw new Error('runScheduledSkill requires config.agent.key (AGENT_KEY) so the skill and persona can be scoped.');
  }
  const baseCtx = channelCtx || { channel: PROACTIVE_CHANNEL, agentKey };
  // Carry the signal on the context so the MCP client cancels in-flight
  // tool calls; merge non-destructively when the caller already set one.
  const ctx = signal && !baseCtx.signal ? { ...baseCtx, signal } : baseCtx;

  if (signal && signal.aborted) return { aborted: true };

  const skill = await loadSkillByName({ mcpClient, channelCtx: ctx, agentKey, name: skillName });
  if (!skill) {
    const err = new Error(`no approved skill named '${skillName}' for agent '${agentKey}'`);
    err.code = 'SKILL_NOT_FOUND';
    throw err;
  }

  if (signal && signal.aborted) return { aborted: true, skill };

  const renderBlocks = [];
  const collect = (evt) => {
    if (evt.type === 'render') renderBlocks.push(...renderEventToBlocks(evt.payload));
    onEvent(evt);
  };

  const userMessage = buildTriggerMessage({ skill, prompt });
  log.info({ agentKey, skill: skill.name }, 'scheduled skill run starting');

  let out;
  try {
    out = await _runTurn({
      config,
      model,
      mcpClient,
      channelCtx: ctx,
      history: [],
      userMessage,
      onEvent: collect,
      signal,
    });
  } catch (err) {
    // An aborted turn surfaces as an AbortError from the model/fetch layer;
    // report it as the same aborted outcome rather than a hard failure.
    if (signal && signal.aborted) {
      log.warn({ agentKey, skill: skill.name }, 'scheduled skill turn aborted (lease lost)');
      return { aborted: true, skill, renderBlocks };
    }
    throw err;
  }

  if (signal && signal.aborted) return { aborted: true, skill, renderBlocks };

  return { text: out.text, history: out.history, skill, renderBlocks };
}

/**
 * Build a `davepi-plugin-cron` handler that runs a named skill and posts
 * the result to a Slack channel. Returns an async function with the cron
 * handler signature `({ log, signal, now, name }) => {}`, ready to hand to
 * `cron.register(jobName, { schedule, handler })`.
 *
 * Options:
 *   - `agent`        — `{ config, model, mcpClient }` from `createAgent()`.
 *   - `skill`        — name of the approved skill to run (required).
 *   - `slackChannel` — Slack channel id/name to post to (required).
 *   - `prompt`       — optional preamble replacing the default trigger.
 *   - `threadTs`     — optional Slack thread to post into.
 *   - `channelCtx`   — optional override; defaults to a `cron` context
 *                      scoped by the agent's `agentKey`. Pass this to run
 *                      one job per tenant in a multi-tenant deployment.
 *
 * The Slack bot token is read from `agent.config.slack.botToken`. The
 * poster is constructed once at build time so a missing token fails fast
 * (mirrors cron's posture of surfacing misconfiguration at registration).
 *
 * A scheduled run has no end-user, so the default `cron` context carries
 * no `channelUserId`. Per-user auth resolves the MCP identity *from* the
 * end-user and therefore requires one — so a per-user agent is rejected at
 * registration unless the caller supplies an explicit `channelCtx` with a
 * `channelUserId` (advanced: a job that acts as a specific linked user).
 * Proactive agents are a service-auth feature by design.
 */
function createScheduledHandler({
  agent,
  skill,
  slackChannel,
  prompt,
  threadTs,
  channelCtx,
  // Optional pre-built poster (e.g. a shared one, or a test double).
  // Defaults to one built from the agent's configured Slack bot token.
  poster: injectedPoster,
  // Test seam forwarded to runScheduledSkill.
  _runTurn,
} = {}) {
  if (!agent || !agent.config || !agent.mcpClient) {
    throw new Error('createScheduledHandler requires an agent ({ config, model, mcpClient }) from createAgent().');
  }
  if (!skill) throw new Error('createScheduledHandler requires a `skill` name to run.');
  if (!slackChannel) throw new Error('createScheduledHandler requires a `slackChannel` to post to.');

  // Per-user auth needs a `channelUserId` to resolve the MCP identity; the
  // default cron context has none, so fail fast at registration rather than
  // deterministically throwing inside `auth.headersFor` on the first tick.
  const isPerUser = agent.auth && agent.auth.mode === 'per-user';
  if (isPerUser && !(channelCtx && channelCtx.channelUserId)) {
    throw new Error(
      'createScheduledHandler requires service auth, or an explicit channelCtx with channelUserId ' +
        "(per-user auth resolves the agent's identity from the end-user, which a scheduled run has none of)."
    );
  }

  const botToken = agent.config.slack && agent.config.slack.botToken;
  const poster = injectedPoster || createSlackPoster({ botToken });

  return async function scheduledSkillHandler({ log = logger, signal } = {}) {
    // Early exit: the lease may already be lost before we start. Don't load
    // the skill or call the LLM if there's no point posting the result.
    if (signal && signal.aborted) {
      log.warn({ skill, channel: slackChannel }, 'scheduled skill aborted before start (lease lost)');
      return { posted: false, aborted: true };
    }

    const out = await runScheduledSkill({
      config: agent.config,
      model: agent.model,
      mcpClient: agent.mcpClient,
      skill,
      prompt,
      channelCtx,
      log,
      signal,
      _runTurn,
    });

    // Cooperative abort: if the lease was lost mid-run, don't post a
    // result the cron framework has already handed to another node.
    if (out.aborted || (signal && signal.aborted)) {
      log.warn({ skill, channel: slackChannel }, 'scheduled skill aborted before post (lease lost)');
      return { posted: false, aborted: true };
    }

    if (!out.text && out.renderBlocks.length === 0) {
      log.info({ skill, channel: slackChannel }, 'scheduled skill produced no output; nothing posted');
      return { posted: false, empty: true };
    }

    await poster.post({
      channel: slackChannel,
      text: out.text,
      renderBlocks: out.renderBlocks,
      threadTs,
    });
    log.info({ skill, channel: slackChannel }, 'scheduled skill posted to slack');
    return { posted: true };
  };
}

module.exports = {
  runScheduledSkill,
  loadSkillByName,
  createScheduledHandler,
  buildTriggerMessage,
  DEFAULT_TRIGGER,
  PROACTIVE_CHANNEL,
};
