'use strict';

const logger = require('./logger');

/**
 * Prompt assembly — the seam tickets B (memory) and C (skills) plug
 * into. Today it implements workstream A: the agent persona renders as
 * prompt **slot #1** (the SOUL.md analog), followed by the static
 * operating contract. With no persona row the agent behaves exactly as
 * it did before this module landed (zero-config fallback).
 *
 * Assembly order (top = most stable, see docs/agent-learning-layer.md §3):
 *   1. Persona (this module)            — identity, slot #1
 *   2. Operating contract (DEFAULT_*)   — the static framing
 *   3+. memory / skills / volatile      — added by later tickets
 *
 * Everything that enters the prompt from a persona row passes through
 * `sanitizePersonaText` first: persona text is operator-authored but is
 * still untrusted input from the model's point of view, and later
 * tickets feed end-user-derived text (customer profiles) through the
 * same seam, so injection scanning belongs here from the start.
 */

const DEFAULT_SYSTEM_PROMPT = `You are an assistant integrated with a dAvePi backend.
You have tools that read and (when authorized) write the backend's data.
Tenant isolation and access control are enforced server-side by the user's
JWT or client identity — you don't need to add "for user X" filters; the
server already does. If a tool returns empty, trust that result instead of
re-asking with looser filters. Prefer the render_table / render_chart tools
to present data instead of dumping raw JSON in your reply.`;

// Slot #1 sections, rendered in Hermes order. Keys match the
// agentPersona schema fields.
const PERSONA_SECTIONS = [
  ['identity', 'Identity'],
  ['style', 'Style'],
  ['avoid', 'Avoid'],
  ['defaults', 'Defaults'],
];

// Per-section length cap. A persona that blows past this is almost
// certainly an accident (or an attempt to flood the prefix), so we
// truncate and log rather than bill a runaway prompt every turn.
const MAX_SECTION_CHARS = 2000;

// C0 control characters (NUL / escapes) minus the legitimate
// whitespace (tab, newline, carriage return). Stripped so they can't
// smuggle a turn boundary past a naive renderer.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F]', 'g');

// Phrases / shapes that try to subvert the surrounding system prompt or
// forge a conversational turn. Persona text never legitimately needs
// these, so we neutralise them before they reach slot #1.
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?|context)/gi,
  /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\b/gi,
  /forget\s+(?:everything|all)\b/gi,
  /\bnew\s+instructions?\s*:/gi,
  // Forged role turns, both "system:" prose and <system>…</system> tags.
  /^\s*(?:system|assistant|developer|user)\s*:/gim,
  /<\/?\s*(?:system|assistant|user|developer)\b[^>]*>/gi,
];

/**
 * Strip/neutralise prompt-injection vectors and cap length on a single
 * persona section. Returns the cleaned string. Calls `onTrip` (if
 * provided) the first time anything is redacted or truncated so the
 * caller can log a single event per assembly.
 */
function sanitizePersonaText(raw, { maxChars = MAX_SECTION_CHARS, onTrip } = {}) {
  if (raw == null) return '';
  let text = typeof raw === 'string' ? raw : String(raw);
  let tripped = false;

  const stripped = text.replace(CONTROL_CHARS, ' ');
  if (stripped !== text) tripped = true;
  text = stripped;

  for (const re of INJECTION_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      tripped = true;
      re.lastIndex = 0;
      text = text.replace(re, '[redacted]');
    }
  }

  if (text.length > maxChars) {
    tripped = true;
    text = `${text.slice(0, maxChars)}…`;
  }

  if (tripped && typeof onTrip === 'function') onTrip();
  return text.trim();
}

/**
 * Render a persona row into the slot #1 block, or `null` when the row
 * has no usable section content. `onTrip` is forwarded to the sanitizer.
 */
function renderPersona(persona, { onTrip } = {}) {
  if (!persona || typeof persona !== 'object') return null;
  const parts = [];
  for (const [field, label] of PERSONA_SECTIONS) {
    const clean = sanitizePersonaText(persona[field], { onTrip });
    if (clean) parts.push(`## ${label}\n${clean}`);
  }
  if (!parts.length) return null;
  return `# Agent persona\n${parts.join('\n\n')}`;
}

/**
 * Assemble the system prompt for a turn.
 *
 *   - `config.llm.systemPrompt` is the operator's explicit override and,
 *     when set, becomes the operating-contract base (slot #2).
 *   - Otherwise the base is the built-in DEFAULT_SYSTEM_PROMPT.
 *   - `fetchPersona`, when provided, is awaited to load the persona row.
 *     A throw or a null result falls back to the base prompt alone
 *     (zero-config), so a backend without the agentPersona schema, an
 *     archived persona, or a read that resolves to nothing all degrade
 *     gracefully.
 *   - When a persona is present it renders as slot #1 ahead of the base.
 */
async function assembleSystemPrompt({ config, fetchPersona, log = logger } = {}) {
  const base = (config && config.llm && config.llm.systemPrompt) || DEFAULT_SYSTEM_PROMPT;

  let persona = null;
  if (typeof fetchPersona === 'function') {
    try {
      persona = await fetchPersona();
    } catch (err) {
      log.warn(
        { err: err && err.message },
        'persona fetch failed; falling back to default system prompt'
      );
    }
  }
  if (!persona) return base;

  let tripped = false;
  const rendered = renderPersona(persona, { onTrip: () => { tripped = true; } });
  if (tripped) {
    log.warn(
      { agentKey: persona.agentKey },
      'persona text tripped the prompt-injection sanitizer; redacted/truncated before use'
    );
  }
  if (!rendered) return base;

  // Persona leads as slot #1; the operating contract follows.
  return `${rendered}\n\n---\n\n${base}`;
}

module.exports = {
  assembleSystemPrompt,
  renderPersona,
  sanitizePersonaText,
  DEFAULT_SYSTEM_PROMPT,
};
