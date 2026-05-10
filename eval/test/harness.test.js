/**
 * Self-tests for the eval harness.
 *
 * The most important invariant: for each prompt N, applying
 * prompt N's `apply.js` to a baseline + prompts 1..N-1's applies
 * should make prompt N's `check.js` return ok:true.
 *
 * If this isn't true, the eval is broken: a perfect agent would
 * still fail. So this is the regression guard on the prompt
 * definitions themselves.
 *
 * Also exercises the harness end-to-end with the stub agent, which
 * lets us validate the full per-prompt loop (copy baseline, apply
 * fixtures, run agent, run check, report) without an API key.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listPrompts, copyBaseline, applyFixturesUpTo, PROMPTS_DIR } = require('../lib/apply-fixtures');
const { runPrompt } = require('../lib/harness');

const BASELINE = path.resolve(__dirname, '..', 'baseline');

test('there are at least 10 prompts (acceptance criterion)', () => {
  assert.ok(
    listPrompts().length >= 10,
    `expected >=10 prompts, found ${listPrompts().length}`
  );
});

for (const name of listPrompts()) {
  test(`${name}: applying apply.js makes check.js pass`, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `davepi-eval-test-${name}-`));
    try {
      copyBaseline(BASELINE, scratch);
      applyFixturesUpTo(name, scratch);

      // Now apply THIS prompt's apply.js — simulates a perfect agent.
      const apply = require(path.join(PROMPTS_DIR, name, 'apply.js'));
      apply(scratch);

      const check = require(path.join(PROMPTS_DIR, name, 'check.js'));
      const verdict = await check(scratch);

      assert.equal(
        verdict && verdict.ok,
        true,
        `check.js returned !ok for the canonical apply: ${verdict && verdict.message}`
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test('end-to-end with the stub agent: prompt 01 plant + run + check', async () => {
  // Plant a stub fixture that mimics what a correct agent would do
  // for prompt 01 (adding title + done fields). Verifies the full
  // CLI codepath (baseline → fixtures → agent → check → result
  // object) without calling the Anthropic API.
  const promptName = '01-task-fields';
  const promptDir = path.join(PROMPTS_DIR, promptName);
  const fixturePath = path.join(promptDir, 'stub.json');
  const correctTaskJs = `module.exports = {
  path: 'task',
  collection: 'task',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'title',  type: String, required: true },
    { name: 'done',   type: Boolean, default: false },
  ],
};
`;
  fs.writeFileSync(
    fixturePath,
    JSON.stringify(
      [
        { tool: 'write_file', input: { path: 'schema/versions/v1/task.js', content: correctTaskJs } },
        { text: 'Added title and done fields to task.' },
      ],
      null,
      2
    )
  );
  try {
    const result = await runPrompt(promptName, { agentMode: 'stub' });
    assert.equal(result.passed, true, `expected pass, got: ${result.message}`);
    assert.match(result.agentResponse, /Added title and done fields/);
    assert.ok(result.durationMs >= 0);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('end-to-end with the stub agent: a bad fixture is flagged as a failure', async () => {
  // Plant a stub that writes the WRONG schema (missing the `done`
  // field). The harness should report passed: false and surface a
  // useful message.
  const promptName = '01-task-fields';
  const promptDir = path.join(PROMPTS_DIR, promptName);
  const fixturePath = path.join(promptDir, 'stub.json');
  const incorrectTaskJs = `module.exports = {
  path: 'task',
  collection: 'task',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'title',  type: String, required: true },
  ],
};
`;
  fs.writeFileSync(
    fixturePath,
    JSON.stringify(
      [
        { tool: 'write_file', input: { path: 'schema/versions/v1/task.js', content: incorrectTaskJs } },
        { text: 'Done.' },
      ],
      null,
      2
    )
  );
  try {
    const result = await runPrompt(promptName, { agentMode: 'stub' });
    assert.equal(result.passed, false, 'expected check to flag the missing field');
    assert.match(result.message, /done/i);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
