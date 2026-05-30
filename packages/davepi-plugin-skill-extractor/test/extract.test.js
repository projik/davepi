'use strict';

/**
 * Unit tests for the extraction core. node:test so the package keeps
 * zero runtime deps; the LLM call is injected as a stub.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractSkill,
  normalizeTranscript,
  parseVerdict,
  validateSkill,
} = require('../lib/extract');

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function transcript(n) {
  // n alternating turns of real-looking content.
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}` });
  }
  return JSON.stringify(out);
}

test('normalizeTranscript parses a JSON string and passes arrays through', () => {
  assert.deepEqual(
    normalizeTranscript('[{"role":"user","content":"hi"}]'),
    [{ role: 'user', content: 'hi' }]
  );
  assert.deepEqual(normalizeTranscript([{ role: 'user', content: 'hi' }]), [
    { role: 'user', content: 'hi' },
  ]);
  assert.deepEqual(normalizeTranscript('not json'), []);
  assert.deepEqual(normalizeTranscript(undefined), []);
});

test('parseVerdict tolerates fences and surrounding prose', () => {
  assert.deepEqual(parseVerdict('{"skill": null}'), { skill: null });
  assert.deepEqual(parseVerdict('```json\n{"skill": null}\n```'), { skill: null });
  assert.deepEqual(
    parseVerdict('Here is my answer:\n{"skill": {"name": "x"}}\nThanks!'),
    { skill: { name: 'x' } }
  );
  assert.equal(parseVerdict('not json at all'), null);
  assert.equal(parseVerdict(123), null);
});

test('validateSkill requires name + body, trims, allows empty description', () => {
  assert.deepEqual(
    validateSkill({ name: '  Reset  ', body: ' steps ', description: ' d ' }),
    { name: 'Reset', body: 'steps', description: 'd' }
  );
  assert.deepEqual(validateSkill({ name: 'x', body: 'y' }), {
    name: 'x',
    body: 'y',
    description: '',
  });
  assert.equal(validateSkill({ name: 'x' }), null); // no body
  assert.equal(validateSkill({ body: 'y' }), null); // no name
  assert.equal(validateSkill(null), null);
});

test('trivial chat (too short) never spends an LLM call', async () => {
  let called = false;
  const skill = await extractSkill({
    history: transcript(2),
    agentKey: 'support',
    minMessages: 4,
    runExtraction: async () => {
      called = true;
      return '{"skill": {"name": "x", "body": "y"}}';
    },
    log: silentLog,
  });
  assert.equal(skill, null);
  assert.equal(called, false, 'runExtraction must not be called for a short transcript');
});

test('non-trivial conversation with a positive verdict yields a skill', async () => {
  const skill = await extractSkill({
    history: transcript(6),
    agentKey: 'support',
    runExtraction: async ({ system, transcript: t }) => {
      assert.match(system, /reusable runbooks/i);
      assert.match(t, /message 0/);
      return JSON.stringify({
        skill: {
          name: 'Reset a locked account',
          description: 'Unlock after repeated failed logins.',
          body: '1. Verify identity.\n2. Clear the lockout.',
        },
      });
    },
    log: silentLog,
  });
  assert.deepEqual(skill, {
    name: 'Reset a locked account',
    description: 'Unlock after repeated failed logins.',
    body: '1. Verify identity.\n2. Clear the lockout.',
  });
});

test('model declines (skill: null) → no skill', async () => {
  const skill = await extractSkill({
    history: transcript(6),
    agentKey: 'support',
    runExtraction: async () => '{"skill": null}',
    log: silentLog,
  });
  assert.equal(skill, null);
});

test('malformed verdict → no skill, no throw', async () => {
  const skill = await extractSkill({
    history: transcript(6),
    agentKey: 'support',
    runExtraction: async () => 'the model rambled without JSON',
    log: silentLog,
  });
  assert.equal(skill, null);
});

test('LLM failure is swallowed (best-effort) and yields no skill', async () => {
  const skill = await extractSkill({
    history: transcript(6),
    agentKey: 'support',
    runExtraction: async () => {
      throw new Error('rate limited');
    },
    log: silentLog,
  });
  assert.equal(skill, null);
});
