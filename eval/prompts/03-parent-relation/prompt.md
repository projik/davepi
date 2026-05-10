Make tasks belong to projects.

On the `task` schema:

- Add a required `projectId` field (type `String`) for the foreign key.
- Add a `relations` map with one entry: `parent` is a `belongsTo`
  relation targeting the `project` schema, with foreign key
  `projectId`.

Don't touch the `project` schema for this change.
