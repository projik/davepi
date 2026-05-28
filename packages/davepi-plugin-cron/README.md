# davepi-plugin-cron

Declarative scheduled jobs for [dAvePi][davepi] with Mongo-backed
distributed locking. Every project hits the "nightly export at 2am",
"reap stale uploads every 10 minutes", "send digest emails Monday
8am" pattern eventually; the moment you scale to two web dynos the
naive `node-cron` answer runs everything twice. This plugin pairs
[`croner`][croner] (zero-dep scheduler with timezone support) with a
`cron_lock` collection so the only thing that fires per tick is
whichever process won the upsert race. Crashed leaseholders' rows
get swept by Mongo's TTL index; long jobs heartbeat-extend their
lease and get an AbortSignal when it's lost.

[davepi]: https://docs.davepi.dev
[hooks]:  https://docs.davepi.dev/features/hooks/
[croner]: https://github.com/Hexagon/croner

## Install

```bash
npm install davepi-plugin-cron
```

Add it to your project's `package.json` under `davepi.plugins`, then
declare jobs under `davepi.cron`:

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-cron"],
    "cron": {
      "nightly-export": {
        "schedule": "0 2 * * *",
        "handler":  "./jobs/nightly-export.js"
      },
      "reap-pending": {
        "schedule": "*/10 * * * *",
        "handler":  "./jobs/reap-pending.js"
      },
      "digest-emails": {
        "schedule": "0 8 * * 1",
        "handler":  "./jobs/digest.js",
        "timezone": "America/New_York"
      }
    }
  }
}
```

Each handler is a module exporting a function (or `{ handler, ... }`
with the same overrides as the package.json declaration):

```js
// jobs/nightly-export.js
module.exports = async ({ log, signal, now, name }) => {
  log.info({ job: name }, 'nightly export starting');
  for await (const batch of stream()) {
    if (signal.aborted) {
      // Heartbeat lost — another process took over. Stop cleanly.
      log.warn({ job: name }, 'aborting: lease lost');
      return;
    }
    await write(batch);
  }
};
```

## Configure

All config is env-driven:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CRON_ENABLED`       | no | `true` (or `false` under `NODE_ENV=test`) | Set to `false` on the web dyno if you only want cron on a worker dyno. |
| `CRON_STATUS_PATH`   | no | `/api/cron` | Empty disables the status + run-now routes. |
| `CRON_DEFAULT_TZ`    | no | `UTC` | Default timezone for jobs that don't specify one. |
| `CRON_LEASE_SECONDS` | no | `300` | Default lease lifetime. Override per-job. Tune to ≥ 2× the longest expected job duration. |

`NODE_ENV=test` auto-disables scheduling (mirrors
`middleware/rateLimit.js`). The plugin still loads registrations and
exposes a `tickOnce(name)` helper so tests can drive a handler
synchronously.

## Programmatic registration

For dynamic schedules (one job per active customer, for example),
register at boot from your own plugin or schema:

```js
const cron = require('davepi-plugin-cron');

cron.register('per-tenant-rollup', {
  schedule:     '0 1 * * *',
  handler:      async ({ log }) => { /* ... */ },
  timezone:     'UTC',
  leaseSeconds: 600,
});

cron.unregister('per-tenant-rollup');   // hot-reload friendly
```

`register()` after `setup()` has run schedules immediately.

## Distributed lock

The Mongo lock is what guarantees exactly-once execution per tick
across a cluster. Implementation:

1. Every tick calls `findOneAndUpdate({ name, expiresAt: { $lt: now } }, { $set: { holderId, expiresAt: now + lease } }, { upsert: true })`.
2. The unique index on `name` makes the upsert race-safe: exactly one of N contenders' upserts succeeds; the others throw `E11000`, which the plugin maps to "another holder owns it — skip this tick."
3. While the handler runs, a background heartbeat ticks every `leaseSeconds/3` and extends `expiresAt`. A lost heartbeat (the row's `holderId` no longer matches ours) flips the handler's `AbortSignal` so it can stop cooperatively.
4. A `expireAfterSeconds: 0` TTL index on `expiresAt` lets Mongo sweep rows whose owners crashed mid-run.

**The lock — not the scheduler — is the source of truth.** Clock
skew between dynos can cause the same cron expression to fire on two
nodes within the same second; the lock catches it.

## Status & manual-trigger endpoints

`GET /api/cron` (admin-only):

```json
{
  "jobs": [
    {
      "name":           "nightly-export",
      "schedule":       "0 2 * * *",
      "timezone":       "UTC",
      "leaseSeconds":   300,
      "nextRun":        "2026-05-29T02:00:00.000Z",
      "lastRun":        "2026-05-28T02:00:00.000Z",
      "lastStatus":     "ok",
      "lastDurationMs": 18342,
      "lastError":      null,
      "runCount":       42,
      "failCount":      0
    }
  ]
}
```

`POST /api/cron/:name/run-now` (admin-only) triggers a manual tick.
Returns `{ ok: true, acquired: true }` if the lock was free, or
`{ ok: true, acquired: false, reason: 'locked' }` if another node
holds it. Useful for backfills.

Both routes require the caller's JWT to carry the `admin` role —
cron is operator infrastructure, not per-tenant data. A non-admin
gets a plain 403 (not 404) because the route's existence is
documented.

## Comparison with davepi-plugin-queue

[`davepi-plugin-queue`](https://www.npmjs.com/package/davepi-plugin-queue)
exposes BullMQ's `repeat: { pattern: ... }` for cron-style
recurrence. Pick whichever matches your infra:

| Use case | Pick |
|----------|------|
| You haven't added Redis yet | `davepi-plugin-cron` (uses the existing Mongo connection) |
| You want retries / observability / DLQ for scheduled jobs | `davepi-plugin-queue` (BullMQ semantics) |
| You want operator-visible status without a dashboard add-on | `davepi-plugin-cron` (`GET /api/cron`) |

Both plugins can coexist in the same project.

## Footguns

- **Lease too short** means a slow job's lease expires mid-run and another node starts a second run; the heartbeat eventually aborts the first. Tune `leaseSeconds ≥ 2× expected duration`. The default of 300s is defensible for most use; bump it for batch jobs.
- **Handler relative paths resolve against the consumer's `cwd`.** This follows the same convention `utils/pluginLoader.js` uses for plugin module specifiers. The `#jobs/*` subpath import (Node's built-in `imports` map) is a clean way to keep handler paths stable across `cwd` changes.
- **Two `register()` calls with the same name throw at the second.** A misconfigured `davepi.cron` block with duplicate keys would silently drop one declaration if we did last-write-wins; refusing makes it visible at boot.
- **Don't call `register()` for the same job in both `davepi.cron` AND a programmatic `cron.register()`.** The package.json declaration loads first; the programmatic one will throw `'already registered'`. Pick one source of truth per job.
