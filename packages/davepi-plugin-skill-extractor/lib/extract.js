'use strict';

/**
 * Skill extraction core — the decision + parsing logic, kept free of
 * any LLM/queue/davepi wiring so it's unit-testable with a stubbed
 * `runExtraction`.
 *
 * Given a resolved conversation transcript, ask a **fresh** extraction
 * agent whether the approach was non-trivial AND the outcome positive,
 * and if so to propose a single reusable runbook. The agent answers
 * with strict JSON — `{ "skill": null }` when there's nothing worth
 * keeping (the common case: greetings, one-shot lookups, dead ends), or
 * `{ "skill": { name, description, body } }` for a genuine runbook.
 *
 * This module owns three things only:
 *   1. Normalising the stored transcript (a JSON string or an array)
 *      into a readable form for the prompt.
 *   2. A cheap pre-filter so trivially short chats never spend an LLM
 *      call (the LLM is still the real arbiter for everything past it).
 *   3. Parsing + validating the model's JSON verdict defensively.
 */

const DEFAULT_MIN_MESSAGES = 4;

const EXTRACTION_SYSTEM_PROMPT = [
  'You are a reviewer that distils reusable runbooks ("skills") from a',
  'resolved customer-service conversation. You are a FRESH instance: you',
  'have no memory of the conversation beyond the transcript you are given.',
  '',
  'Propose a skill ONLY when BOTH are true:',
  '  - The approach was NON-TRIVIAL — the agent did real procedural work',
  '    (a multi-step process, a non-obvious diagnosis, a policy applied',
  '    correctly). A greeting, a single lookup, a "thanks/bye", or an',
  '    unresolved/abandoned thread is NOT worth a skill.',
  '  - The outcome was POSITIVE — the user\'s problem was actually solved.',
  '',
  'When you do propose one, generalise it into a reusable procedure:',
  'strip names, order numbers, emails and other specifics; keep the steps',
  'and the decision points. Write it for the next agent facing the same',
  'situation, not as a recap of this one.',
  '',
  'Respond with STRICT JSON and nothing else, one of exactly:',
  '  {"skill": null}',
  '  {"skill": {"name": "<short imperative title>",',
  '             "description": "<one-line summary for the skill index>",',
  '             "body": "<markdown, numbered steps>"}}',
].join('\n');

/**
 * Coerce the stored transcript into an array of `{ role, content }`.
 * The conversation schema stores `history` as a JSON string; non-HTTP
 * callers may hand us the array directly. Anything unparseable yields
 * an empty transcript (treated as trivial).
 */
function normalizeTranscript(history) {
  if (Array.isArray(history)) return history.filter((m) => m && m.content != null);
  if (typeof history === 'string' && history.trim()) {
    try {
      const parsed = JSON.parse(history);
      return Array.isArray(parsed) ? parsed.filter((m) => m && m.content != null) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Render the transcript as a plain `ROLE: text` block for the prompt. */
function renderTranscript(messages) {
  return messages
    .map((m) => {
      const role = String(m.role || 'user').toUpperCase();
      const content =
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${role}: ${content}`;
    })
    .join('\n');
}

/**
 * Pull a JSON object out of the model's reply, tolerating a ```json
 * fence or leading/trailing prose. Returns the parsed object or null.
 */
function parseVerdict(text) {
  if (typeof text !== 'string') return null;
  let candidate = text.trim();
  // Strip a Markdown code fence if present.
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  // Fall back to the first {...} span if there's surrounding prose.
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Validate + normalise a proposed skill. Requires a non-empty `name`
 * and `body`; `description` is optional but recommended (it's the L0
 * index line). Returns the trimmed skill or null when the shape is off.
 */
function validateSkill(skill) {
  if (!skill || typeof skill !== 'object') return null;
  const name = typeof skill.name === 'string' ? skill.name.trim() : '';
  const body = typeof skill.body === 'string' ? skill.body.trim() : '';
  if (!name || !body) return null;
  const description =
    typeof skill.description === 'string' ? skill.description.trim() : '';
  return { name, description, body };
}

/**
 * Run extraction for one resolved conversation.
 *
 * `runExtraction({ system, transcript, messages, agentKey })` is the
 * injected LLM call; it must resolve to the model's raw text reply.
 * `lib/agent.js` provides the default (a fresh Anthropic call); tests
 * inject a stub.
 *
 * Returns the validated `{ name, description, body }` skill, or `null`
 * when the conversation isn't worth a skill (trivial, abandoned, or the
 * model declined).
 */
async function extractSkill({
  history,
  agentKey,
  runExtraction,
  minMessages = DEFAULT_MIN_MESSAGES,
  log = console,
}) {
  if (typeof runExtraction !== 'function') {
    throw new TypeError('extractSkill requires a runExtraction function');
  }
  const messages = normalizeTranscript(history);
  // Cheap pre-filter: a chat shorter than a couple of exchanges can't
  // hold a non-trivial runbook, so don't spend an LLM call on it.
  if (messages.length < minMessages) {
    return null;
  }
  const transcript = renderTranscript(messages);
  let raw;
  try {
    raw = await runExtraction({
      system: EXTRACTION_SYSTEM_PROMPT,
      transcript,
      messages,
      agentKey,
    });
  } catch (err) {
    (log.warn || log.error || (() => {})).call(
      log,
      { err: err && err.message, agentKey },
      'skill extraction LLM call failed'
    );
    return null;
  }
  const verdict = parseVerdict(raw);
  if (!verdict || verdict.skill == null) return null;
  return validateSkill(verdict.skill);
}

module.exports = {
  extractSkill,
  normalizeTranscript,
  renderTranscript,
  parseVerdict,
  validateSkill,
  EXTRACTION_SYSTEM_PROMPT,
  DEFAULT_MIN_MESSAGES,
};
