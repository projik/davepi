# davepi-plugin-object-storage

Presigned-URL file uploads for [dAvePi][davepi]. Auto-registers a generic `file` schema, mounts upload-url / complete / download-url routes that hand the client a presigned URL so bytes travel **client → bucket** without proxying through the API server. Pluggable backend supports AWS S3, Cloudflare R2, MinIO, and Google Cloud Storage.

[davepi]: https://docs.davepi.dev

## Why this plugin (vs. the in-tree `type: 'File'` field)

The framework already ships a per-field, server-proxied upload pipeline via [`type: 'File'`](https://docs.davepi.dev/features/files/). That covers small attachments (avatars, document scans, logos). This plugin solves a different shape:

- **Big files.** Multi-GB uploads can't ride a multer multipart request — and on serverless (Lambda ~6 MB, Vercel ~4.5 MB) they can't ride the request body at all.
- **Direct-to-bucket.** Client → bucket is one network hop; client → API → bucket is two. With presigned URLs the API server never sees the bytes, so you don't pay egress/ingress twice or burn API CPU/RAM.
- **Files as a first-class resource.** Instead of an embedded `FileMeta` on a parent record, this plugin gives you a real `file` collection — queryable, paginated, deletable, joinable. Right shape for media libraries, chat attachments, CMS asset pickers, anything where the file isn't anchored to one parent.
- **R2 / MinIO / GCS.** The in-tree field is `local` or `s3` only; this plugin adds Cloudflare R2, self-hosted MinIO, and Google Cloud Storage behind a shared API.

Both pipelines coexist in the same app. Use whichever fits.

## Install

```bash
npm install davepi-plugin-object-storage
```

Add it to your project's `package.json` under `davepi.plugins`:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-object-storage"]
  }
}
```

Set the bucket in `.env`:

```bash
S3_BACKEND=aws            # or r2 / minio / gcs
S3_BUCKET=my-uploads
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

That's it — on boot, the plugin constructs the backend adapter, registers the `file` schema, mounts the three custom routes under `/api/files`, and starts a background reaper that sweeps abandoned `pending` uploads.

## Quick start

```js
// 1. Client requests a presigned PUT URL.
const presign = await fetch('/api/files/upload-url', {
  method:  'POST',
  headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
  body:    JSON.stringify({
    contentType:  'image/png',
    originalName: 'company-logo.png',
    size:         12345,             // optional, used for max-bytes gate
    metadata:     { tag: 'avatar' }, // optional, free-form per-record metadata
  }),
}).then((r) => r.json());
// presign = { fileId, key, url, expiresIn, contentType }

// 2. Client PUTs the bytes directly to S3.
await fetch(presign.url, {
  method:  'PUT',
  headers: { 'Content-Type': 'image/png' },
  body:    blob,
});

// 3. Client tells the server the upload landed.
await fetch(`/api/files/${presign.fileId}/complete`, {
  method:  'POST',
  headers: { Authorization: `Bearer ${jwt}` },
}).then((r) => r.json());
// → { fileId, status: 'uploaded', size, etag, ... }

// 4. Later — fetch a short-lived download URL for the file.
const dl = await fetch(`/api/files/${presign.fileId}/download-url`, {
  headers: { Authorization: `Bearer ${jwt}` },
}).then((r) => r.json());
// → { fileId, url, expiresIn }
```

## Configure

All config is env-driven.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `S3_BACKEND`              | no | `aws` | One of `aws` / `r2` / `minio` / `gcs`. Picks the adapter. |
| `S3_BUCKET`               | **yes** (else dormant) | — | Bucket name. |
| `S3_REGION`               | yes for `aws` | from `AWS_REGION` | e.g. `us-east-1`. |
| `S3_ENDPOINT`             | required for `r2` / `minio` | — | Custom endpoint URL. |
| `S3_ACCESS_KEY_ID`        | dev / standalone | — | Falls back to AWS SDK default credential chain (IRSA, EC2/ECS metadata, `~/.aws/credentials`). |
| `S3_SECRET_ACCESS_KEY`    | dev / standalone | — | Same. |
| `S3_FORCE_PATH_STYLE`     | no | `true` for minio, else `false` | Forces `bucket-in-path` URLs. |
| `S3_PUBLIC_BASE_URL`      | no | computed | CDN base for `publicUrl` overrides (e.g. `https://cdn.example.com`). |
| `S3_PUT_URL_TTL_SECONDS`  | no | `300` | Lifetime of presigned PUT URLs. |
| `S3_GET_URL_TTL_SECONDS`  | no | `600` | Lifetime of presigned GET URLs. |
| `S3_MAX_BYTES`            | no | `52428800` (50 MiB) | Max accepted `size` for an upload-url request, and the cap re-checked at `/complete` time. |
| `S3_ALLOWED_MIME`         | no | *(any)* | Comma-separated allowlist (e.g. `image/png,image/jpeg,application/pdf`). Wildcards like `image/*` are honoured. |
| `S3_CASCADE_DELETE`       | no | `false` | If `true`, deleting a `file` record via `DELETE /api/v1/file/:id` also deletes the underlying object. Irreversible — opt-in. |
| `S3_VERIFY_ON_COMPLETE`   | no | `true` | If `true`, `/complete` HEADs the object to verify presence + size before flipping status. Disable only when you trust the upload path end-to-end (e.g. a S3 event-trigger Lambda already verified it). |
| `S3_REAP_ENABLED`         | no | `true` | Background sweep of orphaned `pending` records. Disable when you run cron separately. |
| `S3_REAP_INTERVAL_MS`     | no | `300000` (5 min) | Sweep frequency. |
| `S3_REAP_MULTIPLIER`      | no | `3` | A `pending` record is reaped when `createdAt + putUrlTtl × multiplier < now`. The multiplier gives slow networks comfortable headroom before cleanup. |
| `S3_FILE_PATH`            | no | `file` | Schema path. Override if your project already has its own `file` schema. |
| `S3_FILE_VERSION`         | no | `v1` | Schema version key. |
| `S3_ROUTE_PREFIX`         | no | `/api/files` | Where the upload-url / complete / download-url routes mount. |
| `GCS_PROJECT_ID`          | required for `gcs` | — | GCS project. |
| `GCS_KEY_FILE`            | required for `gcs` | — | Path to a service-account JSON. |

## What gets written

The plugin registers a `file` schema. Each row carries:

| Field | Description |
|-------|-------------|
| `userId`       | Owner. Tenant-scope predicate for every read. |
| `accountId`    | Owner's accountId, when present on the JWT. |
| `key`          | Storage key (`<userId>/<8-hex>/<safe-original-name>`). Write-locked at the API layer. |
| `bucket`       | Bucket the object lives in. Write-locked. |
| `contentType`  | MIME at upload time. Write-locked. |
| `size`         | Bytes, validated against `S3_MAX_BYTES`. Write-locked. |
| `status`       | `pending` → `uploaded`. Write-locked. The plugin's own routes are the only writers. |
| `originalName` | Client-supplied filename. Writable via the regular PUT route. |
| `metadata`     | Free-form `Mixed`. Writable via the regular PUT route so consumers can attach labels. |
| `uploadedAt`   | Set on `/complete`. Write-locked. |
| `etag`         | Storage etag at `/complete`. Write-locked. |

Write-locks use the same sentinel-ACL trick `davepi-plugin-audit` uses for its `audit` collection — the framework's `filterWritable` strips these keys from any inbound POST / PUT body so no client can lie about where their bytes live.

## Reading the file collection

The `file` schema is registered like any other dAvePi schema, so every standard surface works:

```bash
# List my files
GET /api/v1/file?status=uploaded&__sort=createdAt:desc

# Read one
GET /api/v1/file/<id>

# Update metadata
PUT /api/v1/file/<id>
{ "metadata": { "tag": "hero-image" } }

# Hard-delete (also removes the blob if S3_CASCADE_DELETE=true)
DELETE /api/v1/file/<id>
```

GraphQL: `file`, `files`, `fileFilter`, `fileUpdateById`, `fileRemoveById` — same shape as any other dAvePi resource.

## Programmatic API

For schema lifecycle hooks and custom routes:

```js
const storage = require('davepi-plugin-object-storage');

// Issue a presigned PUT URL from inside a hook.
const { url, fileId } = await storage.createUploadUrl({
  user: req.user,
  contentType: 'image/png',
  originalName: 'avatar.png',
  size: 12345,
  metadata: { kind: 'avatar' },
});

// Sign a short-lived GET URL. Returns null if the file isn't owned by
// the caller — same tenant-isolation posture as the REST route.
const dl = await storage.createDownloadUrl({ user: req.user, fileId });

// Server-side delete (both the blob and the record).
await storage.deleteFile({ user: req.user, fileId });

// Adapter escape hatch — call provider-specific APIs directly.
const head = await storage.adapter.headObject({ key });
```

## Bucket CORS

The bucket must allow `PUT` from the origins your client runs on. Paste the JSON below into the bucket's CORS configuration.

### AWS S3

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedOrigins": ["https://app.example.com"],
    "ExposeHeaders":  ["ETag"],
    "MaxAgeSeconds":  3000
  }
]
```

Paste at AWS Console → S3 → Bucket → Permissions → CORS.

### Cloudflare R2

R2 uses the same JSON shape as AWS. Paste at Cloudflare Dashboard → R2 → Bucket → Settings → CORS Policy.

```json
[
  {
    "AllowedHeaders": ["content-type", "content-length"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedOrigins": ["https://app.example.com"],
    "ExposeHeaders":  ["ETag"]
  }
]
```

### MinIO

MinIO has CORS off by default; enable via the `mc` CLI:

```bash
mc admin config set local cors_allow_origin="https://app.example.com"
mc admin service restart local
```

### Google Cloud Storage

GCS uses a slightly different shape — `gsutil` (or the `gcloud storage` newer equivalent) applies CORS from a JSON file:

```json
[
  {
    "origin":         ["https://app.example.com"],
    "method":         ["PUT", "GET"],
    "responseHeader": ["Content-Type", "ETag"],
    "maxAgeSeconds":  3000
  }
]
```

Apply with `gsutil cors set cors.json gs://my-bucket`.

## Soft delete vs. cascade delete

The `file` schema declares `softDelete: false`: a `DELETE /api/v1/file/:id` is a *hard* delete by design. File records track a mutable external resource — leaving a tombstoned row whose blob may or may not still exist in the bucket is more confusing than helpful.

`S3_CASCADE_DELETE` controls whether the **storage object** is removed at the same time. Off by default because storage deletion is irreversible — a misconfigured admin endpoint that runs `DELETE` on every row would otherwise empty the bucket. Once you've validated the operator surface, flip it on.

## Multi-tenant isolation

The same rules as every other dAvePi resource:

- Keys are namespaced by `userId` (`<userId>/<8-hex>/<safe-name>`), so a flat `aws s3 ls` already shows ownership.
- Every route filters by `req.user.user_id`. Foreign-tenant `fileId`s return `404 NOT_FOUND` — never `403 FORBIDDEN`, so the response shape doesn't leak existence.
- The `/complete` and `/download-url` routes refuse to issue presigned URLs for files whose `userId` doesn't match the caller.
- The plugin's own setUp goes through `schemaLoader.moveErrorHandlerToEnd()` after mounting routes so plugin-thrown errors land in the framework's centralised `{ error: { code, message } }` shape.

## Tests

```bash
cd packages/davepi-plugin-object-storage
npm test
```

67 unit tests via `node --test` (config, key generation, AWS adapter, GCS adapter, routes, reaper, plugin setup). Plus an integration test under the framework's Jest suite (`test/plugin-object-storage-integration.test.js`) that drives a real `loadPlugins` → REST upload-url → complete → download-url flow against `mongodb-memory-server` with a mock adapter, asserting tenant isolation, mime/size allowlists, and cascade-delete behaviour.

## License

ISC
