---
title: Computed fields
description: Read-only fields derived at response time from a function — never stored, never writable, always in the typed client.
---

A computed field is a read-only projection of stored data. You
write a function (or async function), the framework runs it on
every read, and the result appears on every surface as if it were
a stored field — typed in the client, queryable in GraphQL,
present on MCP responses, included in the audit-log diffs.

## Declaration

```js
{
  name: 'fullName',
  type: String,
  computed: (record) => `${record.firstName} ${record.lastName}`,
}

{
  name: 'isOverdue',
  type: Boolean,
  computed: (record, ctx) => record.dueDate && record.dueDate < new Date(),
}
```

| Key | Description |
|-----|-------------|
| `type` | Used to type the field in GraphQL, Swagger, and the TS client. Supports the same shapes as stored fields, including arrays (`[String]`). |
| `computed` | A function `(record, ctx) => value` (or `async`). `ctx` carries `{ user, schema, surface }` for cross-cutting decisions. |

## Read-only across every surface

Computed fields are **never** writable:

- POST / PUT bodies have them stripped server-side.
- GraphQL input types (`<Path>Input`) omit them.
- `update_<path>` MCP tool input schemas omit them.
- The typed client's `<Resource>Writeable` interface omits them.

This is structural, not policy — the loader knows which fields are
computed and removes them from the writable shape.

## Where they appear

| Surface | Behaviour |
|---------|-----------|
| REST GET | Field appears on every response. |
| GraphQL output type | Field present, marked nullable if the function can return `undefined`. |
| MCP `get_<path>` / `list_<path>` | Field appears on every record. |
| TypeScript client `<Resource>` interface | Marked `readonly`. |
| Swagger | Field present in the response definition. |
| `_describe` | Listed under the schema's `fields` with `computed: true`. |

## Filtering & sorting

Computed fields are derived at response time — they don't exist in
Mongo. So you can't `?$filter=isOverdue=true` or
`?$sort=fullName:asc`. If you need to filter or sort on a derived
value, choose one:

- **Mirror it as a stored field** updated by a hook or a state-machine `onEnter`.
- **Use an [aggregation](/features/aggregations/)** that includes a `$set` / `$project` for the derived value before `$match` / `$sort`.

## Async computed fields

```js
{
  name: 'unreadMessageCount',
  type: Number,
  computed: async (record, ctx) => {
    return Message.countDocuments({
      threadId: record._id,
      userId: ctx.user.user_id,
      read: false,
    });
  },
}
```

Async functions are awaited. The framework runs them in parallel
across a list response, so 100-record lists with N async computed
fields fan out to `N * 100` parallel queries — useful but easy to
saturate. Either:

- Cache inside the function (`ctx.requestCache.get(key)`).
- Use an [aggregation](/features/aggregations/) for list-wide rollups.
- Mirror the value as a stored field updated on writes.

## Performance

Computed functions run for **every** read. Keep them cheap. If your
function does a `findOne` per record, you've recreated the N+1
problem the relations engine fixes.

A reasonable rule of thumb: pure CPU work fine; one Mongo round-trip
per record is borderline; anything heavier should be denormalised
or moved into an aggregation.

## See also

- [Field options](/reference/fields/#computed-fields) — full reference.
- [Aggregations](/features/aggregations/) — use these instead when you need filtering or list-wide rollups.
- [State machines](/features/state-machines/) — `onEnter` hooks are the right place to mirror a computed value into a stored field.
