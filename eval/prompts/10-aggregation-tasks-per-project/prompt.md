Add an aggregation that returns the total task count grouped by
project for the authenticated user.

On the `task` schema, add an aggregation:

- Name: `countByProject`.
- Description: `Total task count per project for the authenticated user.`
- Pipeline: a single `$group` stage that groups by `$projectId` and
  counts with `$sum: 1`. Sort by count descending.

The framework prepends `$match: { userId }` automatically, so you
don't need to add it — the scope is enforced by the framework.

Don't replace the existing `countByStatus` aggregation; add this
one alongside it.
