/**
 * Cumulative state setup for the eval suite.
 *
 * Each prompt N starts from a project that has prompts 1..N-1's
 * "expected" outcomes already applied — so prompt 5 ("add an
 * aggregation") starts from a project where prompts 1-4 have
 * already landed correctly. The agent doesn't have to redo prior
 * work.
 *
 * The deterministic "what each prompt should produce" lives in
 * `prompts/<NN>-<slug>/apply.js`, exported as a function `(projectRoot) => void`.
 *
 * applyFixturesUpTo(N) walks prompts 1..N-1 in order and runs each
 * apply.js. The result is the prompt-N starting state.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

/**
 * List prompts in ascending order by their leading number.
 */
function listPrompts() {
  return fs
    .readdirSync(PROMPTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^\d+-/.test(name))
    .sort();
}

/**
 * Copy the baseline project into a scratch directory.
 */
function copyBaseline(baselineDir, target) {
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) walk(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  walk(baselineDir, target);
}

/**
 * Apply the deterministic results of every prompt strictly before
 * `targetPromptName`. The target prompt itself is NOT applied — that's
 * the agent's job in the eval run.
 */
function applyFixturesUpTo(targetPromptName, projectRoot) {
  const all = listPrompts();
  const cutIdx = all.indexOf(targetPromptName);
  if (cutIdx === -1) {
    throw new Error(`unknown prompt: ${targetPromptName}`);
  }
  for (let i = 0; i < cutIdx; i++) {
    const apply = require(path.join(PROMPTS_DIR, all[i], 'apply.js'));
    apply(projectRoot);
  }
}

module.exports = { listPrompts, copyBaseline, applyFixturesUpTo, PROMPTS_DIR };
