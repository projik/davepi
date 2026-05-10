/**
 * Per-prompt runner.
 *
 * Each call to `runPrompt(name)`:
 *   1. Creates a scratch directory.
 *   2. Copies the baseline project in.
 *   3. Applies every prior prompt's `apply.js` to bring the state to
 *      "just before this prompt".
 *   4. Reads the prompt's `prompt.md`.
 *   5. Invokes the agent on the scratch project with that prompt.
 *   6. Runs the prompt's `check.js` against the result.
 *   7. Returns a structured result `{ name, passed, message, durationMs }`.
 *
 * Failure modes captured:
 *   - check.js throws → result.passed = false, message = throw message.
 *   - check.js returns { ok: false, message } → result.passed = false.
 *   - check.js returns { ok: true, message? } → result.passed = true.
 *   - agent throws → result.passed = false, message = agent error.
 *
 * The scratch dir is preserved when EVAL_KEEP_TEMP=true (default
 * cleans up). Useful when a check fails and you want to diff the
 * agent's output against the expected apply.js.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { copyBaseline, applyFixturesUpTo, PROMPTS_DIR } = require('./apply-fixtures');
const { runAgent } = require('./agent');

const BASELINE = path.resolve(__dirname, '..', 'baseline');

async function runPrompt(name, { agentMode = process.env.EVAL_AGENT || 'real', model } = {}) {
  const promptDir = path.join(PROMPTS_DIR, name);
  if (!fs.existsSync(promptDir)) {
    throw new Error(`prompt directory not found: ${promptDir}`);
  }

  const promptText = fs.readFileSync(path.join(promptDir, 'prompt.md'), 'utf8').trim();
  const check = require(path.join(promptDir, 'check.js'));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `davepi-eval-${name}-`));
  const started = Date.now();
  let passed = false;
  let message = '';
  let agentResponse = '';

  try {
    copyBaseline(BASELINE, scratch);
    applyFixturesUpTo(name, scratch);

    // If a stub fixture for this prompt exists, copy it into scratch
    // so the stub agent can find it. Real-mode runs ignore it.
    const stubFixture = path.join(promptDir, 'stub.json');
    if (fs.existsSync(stubFixture)) {
      fs.copyFileSync(stubFixture, path.join(scratch, '.eval-stub.json'));
    }

    agentResponse = await runAgent({ agentMode, projectRoot: scratch, prompt: promptText, model });

    const verdict = await check(scratch);
    if (verdict && verdict.ok === false) {
      passed = false;
      message = verdict.message || 'check returned ok: false';
    } else {
      passed = true;
      message = (verdict && verdict.message) || 'all assertions passed';
    }
  } catch (err) {
    passed = false;
    message = err.message;
  } finally {
    if (!process.env.EVAL_KEEP_TEMP) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  return {
    name,
    passed,
    message,
    agentResponse,
    durationMs: Date.now() - started,
    scratchDir: process.env.EVAL_KEEP_TEMP ? scratch : null,
  };
}

module.exports = { runPrompt };
