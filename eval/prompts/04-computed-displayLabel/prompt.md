Add a computed field `displayLabel` to the `task` schema.

- Type: `String`.
- Function: returns `<title> (<status>)` for each record — for
  example, `"Write docs (in_progress)"`.

Use the framework's `computed:` mechanism so the value is derived
on read, not stored.
