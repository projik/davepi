<!--
Thanks for the PR. Fill in the sections below — they're what
reviewers look at first. Delete sections that aren't relevant
(rather than leaving them empty).

If this is a draft, mark the PR as Draft on the right-hand side
so reviewers know to hold off.
-->

## Summary

<!-- 1-3 sentences. What does this change do, end to end? -->

## Why

<!-- Link the issue this addresses (`Closes #N`), or describe the
motivation if there isn't one. -->

## Test plan

<!-- What you ran and what you saw. Be concrete:
  - `npm test` — 420 tests pass
  - Manual: scaffolded a project, hit the new endpoint, got X
  - Edge cases considered: …
-->

## Screenshots

<!-- Only if this touches the admin SPA or the docs site. Drag
them into the PR body — GitHub uploads them inline. -->

## Checklist

- [ ] CHANGELOG.md updated under `## [Unreleased]` (or `skip-changelog` label applied if the change is genuinely changelog-irrelevant).
- [ ] Tests added or updated. New schema surface = integration test; new typed error = code/status/message assertion; bug fix = regression test.
- [ ] No `console.log` / `console.error` introduced (use `req.log` or `require('./utils/logger')`).
- [ ] Async route handlers wrapped in `asyncHandler`.
- [ ] Custom GraphQL resolvers wrapped via `utils/scopeResolver.js`.
- [ ] Tenant scope (`userId`) preserved on every new query path.
- [ ] Docs updated under `docs/site/` if the change is user-visible.

<!-- If you're a first-time contributor, welcome — see CONTRIBUTING.md
for orientation. The maintainer queue can take a few days; ping
on the PR if it's been over two weeks. -->
