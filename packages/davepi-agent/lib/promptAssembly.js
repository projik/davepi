'use strict';

const logger = require('./logger');

/**
 * Prompt assembly — the cache-stable system prompt for `@davepi/agent`.
 *
 * Slots are ordered stable → volatile so the prefix stays byte-identical
 * and the provider cache keeps hitting (docs/agent-learning-layer.md §3):
 *
 *   1. Persona (SOUL)            — identity, ticket A
 *   2. Operating contract        — the static framing (DEFAULT_*)
 *   3. Skill index (L0)          — ticket C (not yet)
 *   4. Agent memory (MEMORY)     — `agentMemory.body`, this ticket
 *   5. Customer profile (USER)   — `customerProfile`, this ticket
 *   — volatile: history + new turn (added by the orchestrator)
 *
 * Slots 1–5 are snapshotted **once at session start** and frozen for the
 * whole conversation; the orchestrator/`conversation.js` own that
 * freezing. Everything that enters the prompt from a memory/persona/
 * profile row passes through `sanitizeText` first: the customer profile
 * is partly written from end-user input, so it is an injection vector
 * into a future session's identity tier, and the persona/memory are
 * untrusted from the model's point of view.
 */

const DEFAULT_SYSTEM_PROMPT = `You are an assistant integrated with a dAvePi backend.
You have tools that read and (when authorized) write the backend's data.
Tenant isolation and access control are enforced server-side by the user's
JWT or client identity — you don't need to add "for user X" filters; the
server already does. If a tool returns empty, trust that result instead of
re-asking with looser filters. Prefer the render_table / render_chart tools
to present data instead of dumping raw JSON in your reply.

Live vs. remembered: any persona, agent-memory, or customer-profile context
below is a snapshot taken when this conversation started. Treat it as slow-
changing background that may be slightly stale — never as live system state.
For anything that can change (order status, ticket state, inventory, balances,
appointments) call a tool to read it fresh; do not answer from remembered text.
Preferences or facts you record take effect in the next conversation, not this
one, so don't rely on a write you just made being reflected here.`;

// Slot #1 sections, rendered in Hermes order. Keys match the
// agentPersona schema fields.
const PERSONA_SECTIONS = [
  ['identity', 'Identity'],
  ['style', 'Style'],
  ['avoid', 'Avoid'],
  ['defaults', 'Defaults'],
];

// Slot #5 sections, from the customerProfile schema.
const PROFILE_SECTIONS = [
  ['preferences', 'Preferences'],
  ['notes', 'Notes'],
];

// Per-section length cap. Text past this is almost certainly an accident
// (or an attempt to flood the prefix), so we truncate and log rather than
// bill a runaway prompt every turn.
const MAX_SECTION_CHARS = 2000;

// C0 control characters (NUL / escapes) minus legitimate whitespace
// (tab, newline, carriage return). Stripped so they can't smuggle a turn
// boundary past a naive renderer.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');

// Phrases / shapes that try to subvert the surrounding system prompt or
// forge a conversational turn. Snapshot text never legitimately needs
// these, so we neutralise them before they reach the prompt.
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
 * snapshot section. Returns the cleaned string. Calls `onTrip` (if
 * provided) the first time anything is redacted or truncated so the
 * caller can log a single event per assembly.
 */
function sanitizeText(raw, { maxChars = MAX_SECTION_CHARS, onTrip } = {}) {
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

// Backwards-compatible alias: ticket A exported `sanitizePersonaText`.
const sanitizePersonaText = sanitizeText;

/**
 * Render a persona row into the slot #1 block, or `null` when the row
 * has no usable section content. `onTrip` is forwarded to the sanitizer.
 */
function renderPersona(persona, { onTrip } = {}) {
  if (!persona || typeof persona !== 'object') return null;
  const parts = [];
  for (const [field, label] of PERSONA_SECTIONS) {
    const clean = sanitizeText(persona[field], { onTrip });
    if (clean) parts.push(`## ${label}\n${clean}`);
  }
  if (!parts.length) return null;
  return `# Agent persona\n${parts.join('\n\n')}`;
}

/**
 * Render an agentMemory row into the slot #4 block (`body`), or `null`
 * when there's nothing usable.
 */
function renderMemory(memory, { onTrip } = {}) {
  if (!memory || typeof memory !== 'object') return null;
  const clean = sanitizeText(memory.body, { onTrip });
  if (!clean) return null;
  return `# Remembered context\nFacts you've recorded about how this account operates:\n\n${clean}`;
}

/**
 * Render a customerProfile row into the slot #5 block, or `null` when
 * there's nothing usable.
 */
function renderProfile(profile, { onTrip } = {}) {
  if (!profile || typeof profile !== 'object') return null;
  const parts = [];
  for (const [field, label] of PROFILE_SECTIONS) {
    const clean = sanitizeText(profile[field], { onTrip });
    if (clean) parts.push(`## ${label}\n${clean}`);
  }
  if (!parts.length) return null;
  return `# Customer profile\nWhat you remember about the person you're talking to:\n\n${parts.join('\n\n')}`;
}

/**
 * Await a snapshot fetcher and render it, swallowing any throw (a backend
 * without the schema, or an MCP hiccup, degrades to "no block" rather
 * than failing the turn). Returns the rendered string or null.
 */
async function loadBlock(fetch, render, { log, label }) {
  if (typeof fetch !== 'function') return null;
  let row = null;
  try {
    row = await fetch();
  } catch (err) {
    log.warn({ err: err && err.message, slot: label }, 'snapshot fetch failed; omitting slot');
    return null;
  }
  if (!row) return null;
  let tripped = false;
  const rendered = render(row, { onTrip: () => { tripped = true; } });
  if (tripped) {
    log.warn({ slot: label }, 'snapshot text tripped the prompt-injection sanitizer; redacted/truncated before use');
  }
  return rendered;
}

/**
 * Assemble the system prompt for a session.
 *
 *   - `config.llm.systemPrompt` is the operator's explicit override and,
 *     when set, becomes the operating-contract base (slot #2).
 *   - `fetchPersona` / `fetchMemory` / `fetchProfile`, when provided, are
 *     awaited to load each snapshot row. A throw or null result simply
 *     omits that slot, so a backend missing any of the schemas (or with
 *     no rows) degrades gracefully and the zero-config path is unchanged.
 *   - Order: persona (slot 1), operating contract (slot 2), memory
 *     (slot 4), profile (slot 5). With no rows at all the result is
 *     exactly the base prompt.
 */
async function assembleSystemPrompt({ config, fetchPersona, fetchMemory, fetchProfile, log = logger } = {}) {
  const base = (config && config.llm && config.llm.systemPrompt) || DEFAULT_SYSTEM_PROMPT;

  const personaBlock = await loadBlock(fetchPersona, renderPersona, { log, label: 'persona' });
  const memoryBlock = await loadBlock(fetchMemory, renderMemory, { log, label: 'memory' });
  const profileBlock = await loadBlock(fetchProfile, renderProfile, { log, label: 'profile' });

  const sections = [];
  if (personaBlock) sections.push(personaBlock); // slot 1
  sections.push(base); // slot 2
  if (memoryBlock) sections.push(memoryBlock); // slot 4
  if (profileBlock) sections.push(profileBlock); // slot 5

  return sections.join('\n\n---\n\n');
}

module.exports = {
  assembleSystemPrompt,
  renderPersona,
  renderMemory,
  renderProfile,
  sanitizeText,
  sanitizePersonaText,
  DEFAULT_SYSTEM_PROMPT,
};
