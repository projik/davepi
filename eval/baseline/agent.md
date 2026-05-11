# Agent guide

You are extending a dAvePi project. Each schema lives under
`schema/versions/v1/<resource>.js` and is a CommonJS module that
exports an object with `path`, `collection`, and `fields` keys.

## Conventions

- `userId` is required on every schema; the framework stamps it.
- `accountId` is auto-stamped too — name custom FKs `parentAccountId`,
  `parent<Resource>Id`, etc.
- Field types: `String`, `Number`, `Boolean`, `Date`, `[String]`,
  or the string `'File'`.

## Adding fields

Edit the schema file's `fields:` array. Don't create new files for
fields on an existing resource.

## State machines

A field with `stateMachine: { initial, states: [...], transitions: { ... } }`
becomes a state-machine field. The framework rejects undeclared
transitions automatically.

## Relations

Add a top-level `relations:` map to the schema:

```js
relations: {
  parent: { belongsTo: 'project', fk: 'projectId' },
  // or hasMany / hasOne
}
```

## Computed fields

```js
{ name: 'displayLabel', type: String,
  computed: (r) => `${r.title} (${r.status})` }
```

Computed is read-only; the framework runs the function at response time.

## Aggregations

Top-level `aggregations: [{ name, pipeline: [ ... ] }]`. The
framework prepends `$match: { userId }` automatically.

## ACL

Top-level `acl: { list: [...roles], delete: [...roles] }` for
document-level role bypass.
Field-level: `field.acl = { read: [...] }`.

## File fields

```js
{ name: 'attachment', type: 'File',
  file: { maxBytes: 1024*1024, accept: ['application/pdf'] } }
```

## Style

- camelCase field names.
- Single quotes in JS.
- Match the indentation of existing files (2 spaces).
- One field per line in `fields:` arrays.
