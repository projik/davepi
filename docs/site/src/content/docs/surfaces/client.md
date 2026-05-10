---
title: TypeScript client
description: davepi gen-client emits a fully-typed TS client per schema — same source of truth as the server.
---

dAvePi ships a code generator that emits a fully-typed TypeScript
client for every loaded schema. Same source of truth (the schema
map) drives the server's REST/GraphQL/Swagger surface AND the
frontend's compile-time types — so a typo on a field name fails
`tsc`, not at 4am in production.

## Generate

```bash
npx davepi gen-client --out ./client/davepi.ts
npx davepi gen-client --out ./client/davepi.ts --base-url https://api.example.com
```

The CLI:

- Boots the schema loader exactly as the HTTP server does (no `app.listen()`).
- Walks the live registry.
- Writes one `.ts` file at `--out`.
- Exits.

Output is **deterministic**: schemas in alphabetical order, no
timestamps, sorted aggregation params. Re-running with the same
registry produces a byte-identical file, so CI diffs stay clean.

## Wire it up

Drop the generated file into your project alongside the runtime
companion:

```
src/
  api/
    davepi.ts            # generated; don't edit
    davepi-runtime.ts    # copied from dAvePi's client/davepi-runtime.ts
```

Use it:

```ts
import { createDavepiClient } from './api/davepi';

const api = createDavepiClient({
  baseUrl: 'https://api.example.com',
  getToken: () => localStorage.getItem('davepi-token') || '',
});

const accounts = await api.account.list({
  filter: { accountName: { $regex: '^Acme' } },
  page: 1,
  perPage: 20,
  include: ['contacts'],          // typed as a literal union
});

await api.account.create(
  { accountName: 'Acme' },
  { idempotencyKey: 'op-123' }
);

await api.quote.transitionStatus(quoteId, 'approved');  // `to` typed as state literal
```

Every response shape, every method signature, every relation name,
every state-machine transition is type-checked at compile time.

## What gets generated

For each schema:

| Symbol | Shape |
|--------|-------|
| `interface <Resource>` | Read shape — server response. Includes computed fields (marked `readonly`), file fields (typed as `FileMeta`), state-machine literal unions, `availableTransitions`, framework metadata. |
| `interface <Resource>Writeable` | Request body shape for POST/PUT. Excludes server-stamped fields, computed, file fields. |
| `type <Resource>Include` | Literal union of relation names — `'contacts' \| 'primaryContact'` — or `never` when no relations are declared. |
| `interface <Resource>Client` | Method signatures: `list`, `get`, `create`, `update`, `delete`, plus `restore` (when soft-delete enabled), `history` (when audit enabled), `search` (when any field is searchable), `<aggregation>(args)` per aggregation, `<relation>(id)` per relation, `transition<Field>(id, to)` per state machine, and `upload<File>` / `fetch<File>Url` / `delete<File>` per `type: 'File'` field. |

Plus one global symbol:

```ts
export interface DavepiClient {
  account: AccountClient;
  contact: ContactClient;
  // ...
}

export function createDavepiClient(opts: ApiOptions): DavepiClient;
```

## The runtime

`davepi-runtime.ts` is hand-written and ships once. It provides:

- `ApiOptions` — `{ baseUrl, getToken, fetch?, headers? }`.
- `ListParams<TInclude>`, `ListResponse<T>`, `IdempotentCreateOpts`, `DeleteResult`, `AuditEntry`, `FileMeta`, `AvailableTransitions`.
- `DavepiError` — `{ status, code, message, details? }`. Thrown for non-2xx responses; `details` carries `INVALID_TRANSITION` / `IDEMPOTENCY_CONFLICT` etc. payloads.
- `buildHttpClient(opts)` — produces the underlying fetch wrapper.
- `makeResourceClient(client, config)` — factory the generator calls per schema.

Dependency-light: zero runtime imports beyond global `fetch`. Works
in Node ≥18, browsers, Cloudflare Workers, Deno, Bun.

## Mongo-querystring on the wire

Filters are passed as a `Record<string, unknown>` and serialised
onto the URL using mongo-querystring conventions:

```ts
api.account.list({
  filter: {
    accountName: { $regex: '^Acme' },
    createdAt:   { $gte: '2025-01-01' },
  },
});
// → GET /api/v1/account?accountName={"$regex":"^Acme"}&createdAt={"$gte":"2025-01-01"}
```

Sub-objects are JSON-encoded; primitives go through as-is.

## File uploads

```ts
const meta = await api.account.uploadLogo(accountId, fileBlob);
// { key, size, contentType, originalName, uploadedAt, url? }

const url = await api.account.fetchLogoUrl(accountId);
// → public URL, or short-lived signed URL for private files

await api.account.deleteLogo(accountId);
```

## Idempotency

```ts
const op = await api.account.create(
  { accountName: 'Acme' },
  { idempotencyKey: crypto.randomUUID() }
);
```

The runtime sets `Idempotency-Key` on the POST. Same key + same
body = original record returned with `Idempotency-Replay: true`
header. See [Idempotency keys](/features/idempotency/).

## Errors

```ts
import { DavepiError } from './api/davepi-runtime';

try {
  await api.quote.transitionStatus(id, 'approved');
} catch (err) {
  if (err instanceof DavepiError && err.code === 'INVALID_TRANSITION') {
    console.log('Allowed:', err.details.allowed);
  }
}
```

The error carries:

- `status` — HTTP status code.
- `code` — typed code (`VALIDATION` / `NOT_FOUND` / `CONFLICT` / `INVALID_TRANSITION` / `IDEMPOTENCY_CONFLICT` / etc.).
- `message` — human-readable description.
- `details` — structured payload when the typed error provides one (e.g. `INVALID_TRANSITION`'s current/attempted/allowed).

## Regeneration workflow

A schema change → regenerate → broken call sites surface in `tsc`:

```bash
git commit -m "Add Account.region field"
npx davepi gen-client --out ./client/davepi.ts
npm run typecheck     # any frontend code that relied on the old shape lights up red
```

Pair with a pre-commit hook or a CI step:

```yaml
- run: npx davepi gen-client --out client/davepi.ts
- run: git diff --exit-code client/davepi.ts
```

This keeps the committed client in lockstep with the schema map.

## See also

- [Schema-driven generation](/concepts/schema-driven/) — why one source of truth for both server and client.
- [Errors](/reference/errors/) — every typed error code the runtime might throw.
- [Idempotency keys](/features/idempotency/) — the `idempotencyKey` opt the runtime turns into a header.
