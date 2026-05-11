---
title: File uploads
description: Type 'File' fields generate per-field upload, fetch, and delete routes — local or S3 storage with public or signed URLs.
---

A `type: 'File'` field tells the loader: "this is an uploaded blob,
not a stored value." The framework generates an upload route, a
fetch route, and a delete route for each file field — plus
matching MCP tools and typed client methods. The field's stored
shape is a `FileMeta` sub-document; the blob lives in your chosen
storage backend.

## Declaration

```js
{
  name: 'logo',
  type: 'File',
  file: {
    maxBytes:    5 * 1024 * 1024,    // 5MB
    accept:      ['image/png', 'image/jpeg'],
    storage:     'local',            // or 's3'
    visibility:  'private',          // 'public' for direct CDN URLs
  },
}
```

| Sub-key | Description |
|---------|-------------|
| `maxBytes` | Hard upload limit. Defaults to 10MB. |
| `accept` | Array of allowed MIME types. Server validates the wire-level type against this list before storage. |
| `storage` | `'local'` (default — disk under `UPLOADS_DIR`) or `'s3'`. GCS support is on the roadmap but not yet implemented. |
| `visibility` | `'public'` for stable URLs, `'private'` (default) for short-lived signed URLs on read. |

## Generated surfaces

| Action | REST | MCP tool | Typed client |
|--------|------|----------|--------------|
| Upload | `POST /api/v1/<path>/:id/<field>` (multipart) | `upload_<path>_<field>` | `api.<resource>.upload<Field>(id, blob)` |
| Fetch URL | `GET /api/v1/<path>/:id/<field>` | `fetch_<path>_<field>` | `api.<resource>.fetch<Field>Url(id)` |
| Delete | `DELETE /api/v1/<path>/:id/<field>` | `delete_<path>_<field>` | `api.<resource>.delete<Field>(id)` |

## Stored `FileMeta` shape

```json
{
  "key":           "abc/logo/8f3...png",
  "size":          12345,
  "contentType":   "image/png",
  "originalName":  "company-logo.png",
  "uploadedAt":    "2026-05-10T12:00:00Z",
  "url":           "https://cdn.example.com/abc/logo/8f3...png"
}
```

`url` is present on `visibility: 'public'` files; `private` files
require a fetch round-trip to get a short-lived signed URL.

## Validation

Both `maxBytes` and `accept` are enforced by multer at parse time —
oversize or wrong-MIME uploads error out before any storage write,
returning `400 VALIDATION` with `recoverable: true`. The framework
also re-checks the MIME server-side after the storage write (some
clients lie about Content-Type), so an attacker can't smuggle an
executable as `image/png`.

## Storage backends

| Backend | Configuration |
|---------|---------------|
| `local` | `UPLOADS_DIR` env var — directory under which blobs are written. Default `./uploads`. |
| `s3` | `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, plus standard AWS credentials chain. |

Per-field storage choice means a single schema can mix backends —
public assets to S3, sensitive uploads to local disk encrypted at
rest, etc.

## Public vs private

| Visibility | URL behaviour | Use when |
|------------|---------------|----------|
| `public` | The `url` field is a direct, stable URL (e.g. CDN). | Logos, marketing assets, anything safe to share publicly. |
| `private` | `url` is absent on `FileMeta`; clients must call the fetch route to receive a signed URL valid for ~5 minutes. | PII, contracts, anything that needs auth-gated reads. |

The fetch route re-checks tenant scoping before issuing a signed
URL — a borrowed `_id` from another tenant returns 404, not a URL.

## Tenant isolation

Storage keys are namespaced by `userId` (`<userId>/<path>/<field>/<id>.<ext>`)
so even if a path were leaked, it wouldn't be guessable for another
tenant. The fetch / delete routes also re-check tenant scoping at
the database layer, so a tampered key can't bypass the model.

## ACL

File fields can carry `acl.read` / `acl.create` / `acl.update`
slots like any other field:

```js
{
  name: 'attachment',
  type: 'File',
  file: { /* ... */ },
  acl: { read: ['admin', 'hr'] },
}
```

Without an overlapping role, the field is stripped from responses
and the `fetch_<path>_<field>` tool returns 403.

## Soft delete

A soft-deleted record's files are NOT removed — `deletedAt` is set,
the file routes return 404 (because the record is filtered), but
the blob persists. On `restore`, the file becomes accessible again.

Hard-delete (whether direct, via `softDelete: { retentionDays }`'s sweep, or
on a `softDelete: false` schema) **does** remove the blob from
storage.

## See also

- [Field options](/reference/fields/#file-fields) — declaration reference.
- [ACL](/features/acl/) — field-level ACL on file fields.
- [Soft delete](/features/soft-delete/) — what happens to blobs on delete.
