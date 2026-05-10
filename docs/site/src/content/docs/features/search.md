---
title: Full-text search
description: Mark a field searchable, get a framework-managed Mongo text index, plus a search_<path> MCP tool and a `q` query parameter.
---

Mark any field `searchable: true` and the framework joins it to a
schema-level Mongo text index, exposes a `?q=...` query parameter
on the list route, sets up a `search_<path>` MCP tool, and adds a
`search` method to the typed client. The text index is owned by the
framework — the loader creates and drops it at the right moments
during hot-reload.

## Declaration

```js
fields: [
  { name: 'name',        type: String, searchable: true, required: true },
  { name: 'description', type: String, searchable: true },
  { name: 'tags',        type: [String], searchable: true },
],
```

Multiple fields can be searchable. The framework builds a single
compound text index spanning all of them, with default Mongo
weighting (1.0). The order of fields matters for tie-breaking but
not for whether they're searched.

## REST: `?q=`

```http
GET /api/v1/contact?q=jane%20doe
```

Returns the same shape as a normal list response, with results
ranked by Mongo's text score by default. Pair with `?__sort=score`
to make the ordering explicit (it's the default when `q` is set):

```http
GET /api/v1/contact?q=jane&__sort=score
```

Combine with filters:

```http
GET /api/v1/contact?q=jane&accountId=abc&__page=1
```

Filters AND with the text predicate — search within a tenant scope
plus any additional constraints.

## GraphQL

The same `q` argument is added to the framework's `<path>Search`
field:

```graphql
{
  contactSearch(q: "jane") {
    results { _id, name, description }
  }
}
```

## MCP

```json
{
  "name": "search_contact",
  "arguments": { "q": "jane" }
}
```

Equivalent to `list_contact` with `sort=score:desc`. The tool only
appears for schemas with at least one `searchable` field.

## Typed client

```ts
const matches = await api.contact.search('jane');
// ListResponse<Contact>
```

## Tenant scope

Search is scoped exactly like any other read: every search query
has `userId: req.user.user_id` injected before the text predicate.
Search across tenants requires the `acl.list` bypass.

## Hot-reload posture

The text index is owned by the framework. On each schema load:

1. The loader collects all `searchable: true` fields.
2. Drops the previous text index for this schema (if any).
3. Creates the new text index spanning the current set.

If you remove `searchable: true` from a field, the next reload
drops it from the index automatically — no manual `db.collection.dropIndex`.

## Limits

- **One text index per collection.** That's a Mongo limit. The framework allocates the schema's text index, so you can't add a hand-built one alongside it without breaking hot-reload.
- **No language stemming controls.** The framework uses Mongo's default English text analyzer. If you need a non-English language or custom stemming, you're past what the schema layer can express — drop down to a custom route.
- **No fuzzy matching.** Mongo's text search is token-based (whole words / phrases). For typo tolerance, point at Atlas Search, OpenSearch, or similar.

## See also

- [Field options](/reference/fields/#indexing--uniqueness) — the `searchable` boolean.
- [REST](/surfaces/rest/) — `?q=` and `__sort=score`.
- [MCP server](/surfaces/mcp/) — `search_<path>` tool.
