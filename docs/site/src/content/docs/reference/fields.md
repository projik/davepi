---
title: Field options
description: Every key recognised inside a fields[] entry, what it does, and where it surfaces.
---

A field is the smallest unit of schema in dAvePi. The loader reads
each entry in `fields[]` and writes Mongoose options, GraphQL
types, Swagger fragments, MCP tool input schemas, and admin SPA
form descriptors from it.

## Anatomy of a field

```js
{
  name:        'amount',
  type:        Number,
  required:    true,
  default:     0,
  min:         0,
  searchable:  false,
  description: 'Deal value in cents.',
}
```

## Core keys

| Key | Type | Description |
|-----|------|-------------|
| `name` | string | Required. Becomes the Mongoose path, the GraphQL field name, the JSON key. Camel-case by convention. |
| `type` | Mongoose type or array | Required. `String`, `Number`, `Boolean`, `Date`, `mongoose.Schema.Types.Mixed`, `[String]`, etc. The framework also recognises the literal string `'File'` for upload fields. |
| `required` | boolean | Mongoose-level required validation. |
| `default` | any \| function | Mongoose default. Functions are evaluated per-document. |
| `description` | string | Surfaces in Swagger, `_describe`, and the generated TS client doc comment. |
| `deprecated` | boolean | Hides the field from the admin SPA's default form and marks the GraphQL field deprecated. |

## Validation

| Key | Type | Description |
|-----|------|-------------|
| `min` / `max` | number / Date | Numeric or date range. |
| `minLength` / `maxLength` | number | String length bounds. |
| `match` | RegExp | String regex check. |
| `enum` | array | Restrict to an exact set. Surfaces as a literal union in the typed client and a select in the admin SPA. |
| `validate` | function or `{ validator, message }` | Mongoose-style custom validator. Failures surface as `400 VALIDATION` with `recoverable: true`. |
| `trim` / `lowercase` / `uppercase` | boolean | String normalizers (Mongoose-native). |

## Indexing & uniqueness

| Key | Description |
|-----|-------------|
| `index` | Boolean. Creates a single-field index. For composite indexes, use [`compositeIndex`](/reference/schema/#compositeindex) at the schema level. |
| `unique` | Boolean. **Avoid for tenant-scoped uniqueness** — `unique: true` creates a *global* index that crosses tenants. Use a `compositeIndex: [{ userId: 1, name: 1 }]` instead. |
| `searchable` | Boolean. Joins the schema's framework-owned full-text index. Triggers a `search_<path>` MCP tool and a `q` query param on the list endpoint. See [Search](/features/search/). |

## References & relations

| Key | Description |
|-----|-------------|
| `reference` | Legacy shorthand: `reference: 'account'` makes this field an FK to the `account` schema. The new shape is the schema-level `relations` map; the field shorthand is preserved for back-compat. See [Relations](/features/relations/). |

For new code, declare the FK as a plain `String` and put the
relationship in the schema-level `relations` map — that gives you a
named accessor (`__include=account`), generated MCP tools, and
typed client method per relation.

## Computed fields

```js
{
  name: 'isOverdue',
  type: Boolean,
  computed: (record) => record.dueDate && record.dueDate < new Date(),
}
```

| Key | Description |
|-----|-------------|
| `computed` | A pure function (or async function) of `(record, ctx)`. Runs at response time on every read; the result is added to the response and the GraphQL output type, never stored in Mongo. |

Computed fields are read-only across every surface — POST / PUT
bodies, GraphQL input types, MCP `create_*` and `update_*` tools
all strip the field server-side. See
[Computed fields](/features/computed/).

## State machine

```js
{
  name: 'status',
  type: String,
  stateMachine: {
    initial: 'draft',
    states: ['draft', 'review', 'approved', 'rejected', 'archived'],
    transitions: {
      draft:    ['review', 'archived'],
      review:   ['approved', 'rejected'],
      approved: ['archived'],
      rejected: ['draft'],
    },
    onEnter: {
      approved: async (record, ctx) => { /* side-effect */ },
    },
  },
}
```

| Key under `stateMachine` | Description |
|--------------------------|-------------|
| `initial` | Stamped server-side on POST. Clients cannot pick a non-initial state on create. |
| `states` | Required array of allowed values. Becomes a literal union in the typed client. |
| `transitions` | Map of `current -> allowed nexts`. Any change not listed surfaces as `400 INVALID_TRANSITION` with `current / attempted / allowed` in the body. |
| `onEnter` | Map of `state -> async function(record, ctx)`. Runs once per arrival; errors are logged but don't fail the mutation. |

Transitions ride on the standard update path — the framework
validates the move against `transitions[current]` before
persisting:

- REST: `PUT /api/v1/<path>/:id` with `{ <field>: <to> }`.
- GraphQL: `<path>UpdateById(_id, record: { <field>: <to> })`.
- MCP: `update_<path>` with `{ id, record: { <field>: <to> } }`.

Plus, automatically:

- An `availableTransitions[<field>]` virtual on every read.
- A `transition<Field>(id, to)` convenience method on the typed client (a typed wrapper around the PUT).

See [State machines](/features/state-machines/).

## File fields

```js
{
  name: 'logo',
  type: 'File',
  file: {
    maxBytes: 5 * 1024 * 1024,    // 5MB
    accept:   ['image/png', 'image/jpeg'],
    storage:  'local',            // or 's3' / 'gcs'
    visibility: 'private',        // 'public' for direct CDN URLs
  },
},
```

`type: 'File'` triggers the file pipeline:

| Sub-key under `file` | Description |
|----------------------|-------------|
| `maxBytes` | Hard upload limit. Defaults to 10MB. |
| `accept` | Array of allowed MIME types. Server validates the wire-level type against this list before storage. |
| `storage` | `'local'` (default — disk under `STORAGE_LOCAL_DIR`), `'s3'`, or `'gcs'`. |
| `visibility` | `'public'` for stable URLs, `'private'` (default) for short-lived signed URLs on read. |

The framework generates one upload route, one fetch route, one
delete route per file field, plus matching MCP tools and typed
client methods. The field's stored shape is a `FileMeta`
sub-document — never a raw blob in Mongo. See
[File uploads](/features/files/).

## Field-level ACL

```js
{
  name: 'salary',
  type: Number,
  acl: {
    read:   ['admin', 'hr'],   // only these roles see this field on reads
    create: ['admin', 'hr'],   // only these roles can supply on POST
    update: ['admin', 'hr'],   // only these roles can change on PUT
  },
},
```

Field-level ACL applies on top of document-level scoping. It strips
the field from REST/GraphQL/MCP responses for callers without an
overlapping role, and rejects writes server-side. The same
projection runs on webhook payloads and audit-log diffs — there's
no side channel that bypasses ACL. See [ACL](/features/acl/).

## Special fields

Two field names have framework-level meaning. Any schema can
declare them; the loader recognises them by name.

### `userId`

The tenant column. Every framework query injects
`userId: req.user.user_id` from the JWT. The REST POST handler
stamps it server-side; the GraphQL input types strip it from the
wire. **Never use `userId` for anything other than the tenant
identity.**

### `accountId`

The org / account column for multi-org models. Stamped server-side
identically to `userId`. **Don't use `accountId` as a custom
foreign key** — your client-supplied value would be clobbered by
the stamping pass. Name custom FKs `parentAccountId` / `orgId` /
etc.

See [Tenant isolation](/concepts/tenancy/) for the full set of
guarantees.

## Field reference cheatsheet

```js
// String with full-text search
{ name: 'name', type: String, required: true, searchable: true },

// Money in cents (always store integers)
{ name: 'amountCents', type: Number, required: true, min: 0 },

// Enum
{ name: 'priority', type: String, enum: ['low', 'med', 'high'], default: 'med' },

// Computed
{ name: 'fullName', type: String,
  computed: (r) => `${r.firstName} ${r.lastName}` },

// State machine
{ name: 'status', type: String,
  stateMachine: { initial: 'open', states: ['open', 'closed'],
                  transitions: { open: ['closed'], closed: ['open'] } } },

// Reference (legacy shorthand)
{ name: 'accountId', type: String, reference: 'account' },

// File
{ name: 'attachment', type: 'File',
  file: { maxBytes: 10*1024*1024, accept: ['application/pdf'] } },

// Hidden from non-admins
{ name: 'salary', type: Number, acl: { read: ['admin'] } },
```

## See also

- [Schema file shape](/reference/schema/) — top-level keys.
- [Conventions](/reference/conventions/) — naming, what to put where.
- [Computed fields](/features/computed/), [State machines](/features/state-machines/), [Files](/features/files/), [ACL](/features/acl/) — feature deep dives.
