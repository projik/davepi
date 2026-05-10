#!/usr/bin/env node
/**
 * Eval CLI.
 *
 * Usage:
 *   node bin/run-eval.js                       # run all prompts
 *   node bin/run-eval.js --prompt 03           # run a single prompt by index
 *   node bin/run-eval.js --prompt 03-parent-relation
 *   EVAL_AGENT=stub node bin/run-eval.js       # use the stub agent (no API)
 *   EVAL_KEEP_TEMP=1 ...                       # don't clean up the scratch dir
 *   ANTHROPIC_API_KEY=... ...                  # required for real-agent mode
 *
 * Output:
 *   - Tap-style line per prompt to stdout.
 *   - results/latest.json with the full per-prompt record.
 *   - results/badge.json — shields.io endpoint-compatible payload
 *     ({ schemaVersion: 1, label: 'agent eval', message: 'X/Y', color }).
 *
 * Exit code mirrors the worst per-prompt outcome — 0 if all passed,
 * 1 if any failed. The exit code is what the nightly workflow keys
 * off of; the JSON files are for badge + docs page rendering.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runPrompt } = require('../lib/harness');
const { listPrompts } = require('../lib/apply-fixtures');

function out(line) { process.stdout.write(line + '\n'); }
function err(line) { process.stderr.write(line + '\n'); }

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { prompts: null, model: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--prompt' || a === '-p') {
      opts.prompts = (opts.prompts || []).concat(args[++i]);
    } else if (a === '--model') {
      opts.model = args[++i];
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (!a.startsWith('--')) {
      // Bare arg treated as a prompt selector.
      opts.prompts = (opts.prompts || []).concat(a);
    }
  }
  return opts;
}

function help() {
  out(`Usage: run-eval [--prompt <name-or-index>] [--model <model>]

Options:
  --prompt, -p NAME    Run a single prompt. Can be the directory
                       name (e.g. 03-parent-relation), just the
                       leading number (e.g. 03), or repeated for
                       multiple. Default: all prompts.
  --model MODEL        Anthropic model id. Default: claude-sonnet-4-6.

Environment:
  ANTHROPIC_API_KEY    Required in default 'real' agent mode.
  EVAL_AGENT           'real' (default) or 'stub'. Stub replays a
                       fixture; useful for tests + local dev without
                       an API key.
  EVAL_KEEP_TEMP       If set, keeps the scratch project directory
                       so you can inspect what the agent produced.
`);
}

function resolveSelectors(selectors, all) {
  if (!selectors || selectors.length === 0) return all;
  const out = [];
  for (const sel of selectors) {
    // Match by full directory name or by leading numeric index.
    const match = all.find((name) => name === sel || name.startsWith(sel + '-'));
    if (!match) {
      throw new Error(`unknown prompt: ${sel}`);
    }
    out.push(match);
  }
  return out;
}

function badgeColor(passed, total) {
  if (total === 0) return 'lightgrey';
  const pct = passed / total;
  if (pct >= 0.9) return 'brightgreen';
  if (pct >= 0.7) return 'green';
  if (pct >= 0.5) return 'yellow';
  if (pct >= 0.3) return 'orange';
  return 'red';
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    help();
    process.exit(0);
  }

  const all = listPrompts();
  let toRun;
  try {
    toRun = resolveSelectors(opts.prompts, all);
  } catch (e) {
    err(e.message);
    process.exit(1);
  }

  out(`1..${toRun.length}`);
  const results = [];
  for (let i = 0; i < toRun.length; i++) {
    const name = toRun[i];
    const num = i + 1;
    let result;
    try {
      result = await runPrompt(name, { model: opts.model });
    } catch (e) {
      result = {
        name,
        passed: false,
        message: `harness error: ${e.message}`,
        durationMs: 0,
        agentResponse: '',
      };
    }
    results.push(result);
    const ok = result.passed ? 'ok' : 'not ok';
    out(`${ok} ${num} - ${name}  # ${result.durationMs}ms  ${result.passed ? '' : '— ' + result.message}`);
  }

  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;
  out('');
  out(`# passed ${passedCount}/${total}`);

  // Persist the structured results next to the source so the badge
  // endpoint and the docs-site page have a single canonical file to
  // read from. The nightly workflow commits these back to main.
  const resultsDir = path.resolve(__dirname, '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, 'latest.json'),
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        agentMode: process.env.EVAL_AGENT || 'real',
        model: opts.model || 'claude-sonnet-4-6',
        total,
        passed: passedCount,
        results: results.map((r) => ({
          name: r.name,
          passed: r.passed,
          message: r.message,
          durationMs: r.durationMs,
        })),
      },
      null,
      2
    ) + '\n'
  );
  fs.writeFileSync(
    path.join(resultsDir, 'badge.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        label: 'agent eval',
        message: `${passedCount}/${total}`,
        color: badgeColor(passedCount, total),
      },
      null,
      2
    ) + '\n'
  );

  process.exit(passedCount === total ? 0 : 1);
}

main().catch((e) => {
  err(e && e.stack ? e.stack : String(e));
  process.exit(2);
});
