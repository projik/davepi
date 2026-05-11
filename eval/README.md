# dAvePi agent eval

A nightly harness that drives Claude through prompts of escalating
complexity against a scratch dAvePi project, scores each with a
programmatic check, and publishes the pass-rate.

Full design and rationale: <https://docs.davepi.dev/concepts/agent-eval/>.

## Layout

```
eval/
├── README.md              you are here
├── package.json
├── bin/
│   └── run-eval.js        CLI runner
├── lib/
│   ├── agent.js           Anthropic SDK wrapper + stub-agent path
│   ├── apply-fixtures.js  cumulative state setup
│   └── harness.js         per-prompt runner
├── baseline/              starting state for prompt 01 (project + task schemas)
├── prompts/
│   └── NN-name/
│       ├── prompt.md      what the agent receives
│       ├── apply.js       deterministic reference implementation
│       └── check.js       assertion fn (projectRoot) → { ok, message }
├── results/
│   ├── latest.json        full per-prompt record from the latest run
│   └── badge.json         shields.io endpoint payload
└── test/
    └── harness.test.js    self-tests (no API key needed)
```

## Run it

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run eval

# Single prompt:
ANTHROPIC_API_KEY=sk-ant-... npm run eval -- --prompt 03

# Stub agent (no API key — useful for harness development):
npm run eval:stub
```

## Self-tests

```bash
npm test
```

Validates the harness's invariants without calling the API:

- There are ≥10 prompts (acceptance criterion for #65).
- For each prompt, `apply.js` produces a state that `check.js`
  accepts. If this is ever false, the eval is broken — a perfect
  agent would still fail.
- The stub-agent loop (plant fixture → run → check) works end to
  end.

## Why two CI workflows

- `.github/workflows/eval-self-test.yml` runs on every PR
  touching `eval/`. Free, fast, no API key.
- `.github/workflows/eval.yml` runs nightly with the real Anthropic
  API. Commits `results/latest.json` and `results/badge.json` back
  to `main` so the README badge and docs page stay current.

## Adding a new prompt

1. Pick the next number and a slug: `prompts/11-my-new-prompt/`.
2. Write `prompt.md` (natural-language task), `apply.js`
   (deterministic reference), and `check.js` (assertion).
3. `npm test` — the self-tests verify the prompt is internally
   consistent.
4. The CLI picks it up automatically on the next run.

The cumulative state setup means prompt 11 starts from the
deterministic outcome of prompts 1-10. If you need a different
starting state, that's a sign the prompt should be earlier in the
sequence.
