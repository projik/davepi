---
title: Agent eval suite
description: dAvePi runs a nightly eval that drives Claude through prompts of escalating complexity. The pass-rate is the agent-first claim, made measurable.
---

dAvePi's positioning — that agents build apps on it — is testable.
A harness in [`eval/`](https://github.com/projik/davepi/tree/main/eval)
runs Claude against 10 prompts of escalating complexity, scoring
each with a programmatic check. The pass-rate runs nightly, gets
committed back to `main`, and feeds both the README badge and this
page.

## Latest pass-rate

![Agent eval pass rate](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fprojik%2Fdavepi%2Fmain%2Feval%2Fresults%2Fbadge.json)

The badge above is rendered from
[`eval/results/badge.json`](https://github.com/projik/davepi/blob/main/eval/results/badge.json)
on `main`. The nightly workflow commits that file (plus the
per-prompt breakdown in
[`eval/results/latest.json`](https://github.com/projik/davepi/blob/main/eval/results/latest.json))
after every run, so this number is at most ~24 hours behind the
latest commit.

## What the prompts cover

Each is a single, concrete change against a tiny task-tracker
project. They build on each other — prompt 3's starting state is
the deterministic outcome of prompts 1 and 2.

| # | Prompt | Tests |
|---|--------|-------|
| 01 | Add `title` (required) + `done` (default false) fields to `task`. | Basic field declaration. |
| 02 | Add a `status` state machine: `todo → in_progress → done`. | State machines with terminal states. |
| 03 | Add a `parent` `belongsTo` relation from `task` to `project`. | Relations + foreign-key naming. |
| 04 | Add a computed `displayLabel` field joining title and status. | `computed:` field functions. |
| 05 | Add an aggregation `countByStatus`. | Aggregation declaration with `$group`. |
| 06 | Restrict DELETE to admins via `acl.delete`. | Document-level ACL. |
| 07 | Add a file field `attachment` (PDFs only, 1 MB max). | `type: 'File'` + `accept` / `maxBytes` config. |
| 08 | Mark `title` + a new `description` field as `searchable: true`. | Full-text search opt-in. |
| 09 | Add `internalNotes` field readable only by admins. | Field-level ACL (read), without restricting writes. |
| 10 | Add a second aggregation `countByProject`, sorted by count. | Multiple aggregations + sort stages. |

## How a prompt is scored

Each prompt directory contains three files:

- **`prompt.md`** — the natural-language task the agent receives.
- **`apply.js`** — a deterministic reference implementation. The
  harness uses it to seed the starting state for downstream prompts
  (so prompt 5 starts from prompts 1-4 already done correctly), and
  the self-tests use it to prove the check / apply pair is internally
  consistent (a perfect agent would always pass).
- **`check.js`** — a function `(projectRoot) => { ok, message }`.
  It `require()`s the agent's output (the schema file) and asserts
  on the resulting object. Returns `ok: false` with a useful
  message on any deviation.

The harness invokes the agent with a small tool surface
(`read_file`, `write_file`, `list_directory`) scoped to the
project directory. A system prompt seeded from the project's own
`agent.md` tells Claude the framework's conventions — same content
that ships in every scaffolded project, so the eval tests the
same path a real user would have.

## Reading the score

The latest run is committed to
[`eval/results/latest.json`](https://github.com/projik/davepi/blob/main/eval/results/latest.json)
and rendered on the README via [shields.io](https://shields.io)
pointed at [`eval/results/badge.json`](https://github.com/projik/davepi/blob/main/eval/results/badge.json).

Each result includes:

- `name` — the prompt directory name.
- `passed` — boolean.
- `message` — what the check found (or `"all assertions passed"`).
- `durationMs` — wall clock of the agent's turn-loop for that prompt.

A failed prompt doesn't fail the workflow — the eval keeps running
through the remaining prompts and publishes the partial-pass
result. The exit code is captured as a warning, not a hard
failure, so the badge updates regardless.

## Cost and cadence

The eval runs nightly at 06:00 UTC. Each full run is 10 prompts ×
roughly 5-15 model turns each, so ~50-150 messages against a
mid-tier Claude model. Cost per run is in the dollars-not-tens, but
the budget is the maintainer's `ANTHROPIC_API_KEY` — we don't
publish the bill.

To trigger an ad-hoc run after a meaningful change (new framework
feature, agent.md tweak, etc.) the workflow has a manual
`workflow_dispatch` trigger on the Actions tab.

## What this is and isn't

**Is.** A regression guard against changes to the framework that
break the agent experience — schema vocabulary churn, missing
fields in `_describe`, agent.md drift. If a refactor lands and
the eval drops from 10/10 to 7/10, the next morning's commit
shows exactly which prompts regressed.

**Isn't.** A benchmark of model intelligence. Different Claude
versions will score differently, but that's a side effect — the
goal is to detect framework regressions, not to rank models.

**Isn't.** Exhaustive. The 10 prompts cover the common feature
surface, not every edge case. The eval is a smoke test for the
agent-first story, not a substitute for the framework's unit
tests.

## Running it locally

```bash
cd eval
npm install
ANTHROPIC_API_KEY=sk-ant-... node bin/run-eval.js

# Or a single prompt:
ANTHROPIC_API_KEY=sk-ant-... node bin/run-eval.js --prompt 03

# Or with the stub agent (replays a fixture; useful for testing the
# harness itself without spending tokens):
EVAL_AGENT=stub node bin/run-eval.js --prompt 01
```

Setting `EVAL_KEEP_TEMP=1` preserves the scratch directory after
each prompt so you can diff the agent's output against the
canonical `apply.js`.

## See also

- The [harness source](https://github.com/projik/davepi/tree/main/eval) on GitHub.
- [Concepts → Why agents come first](/concepts/agent-first/) — the design rationale this eval exists to validate.
- The [nightly workflow](https://github.com/projik/davepi/actions/workflows/eval.yml).
