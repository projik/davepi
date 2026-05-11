Add an aggregation to the `task` schema:

- Name: `countByStatus`.
- Description: `Task count grouped by status for the authenticated user.`
- Pipeline: a single `$group` stage that groups by `$status` and
  counts the records (`$sum: 1`).

The framework prepends `$match: { userId }` automatically, so the
pipeline body is just the `$group`.
