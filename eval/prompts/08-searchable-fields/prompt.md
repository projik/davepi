Make the `task` schema searchable by title.

- Add a `description` field of type `String` (not required).
- Mark `title` and `description` as `searchable: true` so the
  framework's full-text search picks them up.

The framework owns the Mongo text index — you only need to flag
the fields.
