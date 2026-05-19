---
title: Plugins
description: Cross-cutting extensions for dAvePi — register routes, subscribe to record events, integrate third-party systems. Loaded from package.json.
---

A plugin is a Node module that gets a one-time chance to extend
the running dAvePi app: register routes, attach middleware,
subscribe to record events, schedule background work. Plugins are
the right tool when the work cuts across resources — audit
exports, third-party integrations, scheduled jobs, ad-hoc routes
that span schemas.

For invariants and side effects that belong to **one** resource
(validate before save, send a welcome email on create), use a
[lifecycle hook](/features/hooks/) on the schema file instead.

## Registering a plugin

List plugin module specifiers under `davepi.plugins` in **your
project's** `package.json` (not the framework's):

```json
{
  "name": "my-app",
  "dependencies": {
    "davepi": "^1.0.4",
    "davepi-plugin-slack": "^1.0.0"
  },
  "davepi": {
    "plugins": [
      "./plugins/audit-export.js",
      "davepi-plugin-slack"
    ]
  }
}
```

Specifiers can be:

| Form | Resolution |
|------|-----------|
| `./plugins/audit-export.js` | Path relative to `process.cwd()` (your project root). |
| `/absolute/path/to/plugin.js` | Absolute path, loaded as-is. |
| `davepi-plugin-slack` | Node module resolution from your project root — installed packages win over anything next to the framework. |

The `davepi.plugins` list is the only place that uses path-form
specifiers — everywhere else in your project (schemas, hooks,
other plugins, tests) `require` plugins via the `#plugins/`
subpath import alias, e.g. `require('#plugins/audit-export')`.
See [Conventions › Local requires](/reference/conventions/#local-requires-subpath-imports).

Plugins load **after** every initial schema is registered, in
declaration order. Each plugin's `setup` is awaited before the
next one runs, so a plugin that establishes shared state for
later plugins is well-defined.

## Plugin module shape

```js
// ./plugins/audit-export.js
module.exports = {
  name: 'audit-export',
  async setup({ app, schemaLoader, bus, log, appName }) {
    log.info({ appName }, 'setting up audit export');

    // 1. Mount a custom route.
    app.get('/api/v1/_audit-export', auth(true), async (req, res) => {
      // ...
    });

    // 2. Subscribe to record events.
    bus.on('record', (event) => {
      if (event.type.endsWith('.deleted')) {
        archive(event);
      }
    });

    // 3. Wire one route per resource.
    for (const key of schemaLoader.listSchemas()) {
      const entry = schemaLoader.getEntry(key);
      app.get(`/api/v1/${entry.schema.path}/_export`, async (req, res) => {
        // ...
      });
    }
  },
};
```

### Required fields

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Used as the child logger's key (`log.child({ plugin: name })`). Visible in operator logs. |
| `setup` | function | Async or sync. Called exactly once per process. Receives the API object below. |

A module without `setup` throws at boot — the loader refuses to
register a no-op plugin silently.

### Setup API

The object passed to `setup` carries everything a plugin needs:

| Key | Type | What it's for |
|-----|------|---------------|
| `app` | Express app | The same instance schemas mount onto. Use `app.use(...)`, `app.get(...)`, etc. The framework re-asserts `errorHandler` at the tail of the stack after plugins finish, so thrown errors in plugin routes flow through the standard response shape. |
| `schemaLoader` | object | The live registry. Use `listSchemas()`, `getEntry(key)`, `onChange(fn)`, `runAggregation({ ... })`. See [Schema-driven generation](/concepts/schema-driven/) for the loader's internals. |
| `bus` | `EventEmitter` | The same in-process bus that fires `record` events for every CRUD mutation. See [Event bus](#event-bus) below. |
| `log` | pino logger | A child logger keyed by the plugin's `name`. Use `log.info`, `log.warn`, `log.error`. |
| `appName` | string | The `APP_NAME` env var (defaults to `"dAvePi"`). Convenience for log lines and integration payloads. |

## What plugins commonly do

### Mount cross-cutting routes

```js
async setup({ app, schemaLoader }) {
  app.get('/api/v1/_schemas', (req, res) => {
    res.json({ schemas: schemaLoader.listSchemas() });
  });
}
```

Mount with `auth(true)` if the route should require a JWT.

```js
const auth = require('davepi/middleware/auth');

async setup({ app }) {
  app.get('/api/v1/_admin/usage', auth(true), async (req, res) => {
    if (!req.user.roles?.includes('admin')) {
      return res.status(403).json({ error: { code: 'FORBIDDEN' } });
    }
    res.json(await computeUsage());
  });
}
```

### Subscribe to record events

The bus fires a `record` event for every successful CRUD
mutation across every schema. Listen once at setup:

```js
async setup({ bus, log }) {
  bus.on('record', async (event) => {
    if (event.type !== 'order.created') return;
    try {
      await postToSlack(event.record);
    } catch (err) {
      log.error({ err, recordId: event.recordId }, 'slack post failed');
    }
  });
}
```

### One route per resource

Plugins run after the schema pass, so the registry is fully
populated:

```js
async setup({ app, schemaLoader }) {
  for (const key of schemaLoader.listSchemas()) {
    const { schema } = schemaLoader.getEntry(key);
    app.post(`/api/v1/${schema.path}/_clone`, auth(true), async (req, res) => {
      // ...
    });
  }
}
```

### Expose helpers for hooks to call

A plugin module is just a CommonJS module — anything it exports
can be required from a schema's [lifecycle hook](/features/hooks/).
Keep one-time client initialisation in `setup` (so the plugin owns
its lifecycle) and export the per-call helpers on
`module.exports`:

```js
// plugins/postmark.js
const { ServerClient } = require('postmark');

let client = null;

async function sendEmail({ to, subject, body }) {
  if (!client) throw new Error('postmark not initialised');
  return client.sendEmail({ From: 'noreply@example.com', To: to, Subject: subject, TextBody: body });
}

module.exports = {
  name: 'postmark',
  async setup({ log }) {
    client = new ServerClient(process.env.POSTMARK_TOKEN);
    log.info({}, 'postmark ready');
  },
  sendEmail,   // exported helper
};
```

```js
// schema/versions/v1/user.js
const postmark = require('#plugins/postmark');

module.exports = {
  path: 'user',
  hooks: {
    afterCreate: async ({ record }) => {
      await postmark.sendEmail({
        to: record.email,
        subject: 'Welcome',
        body: `Hi ${record.firstName}!`,
      });
    },
  },
  // ...
};
```

This works because:

1. Schema files are required at boot — the `require('#plugins/postmark')` resolves the module exports immediately, with `client` still `null`.
2. Plugin `setup` runs after the schema pass — `client` becomes a real Postmark client.
3. Hooks only fire on request handling — by which point `client` is guaranteed initialised.

The framework doesn't impose anything here — it's plain Node
module semantics. The convention is to (a) `require` plugins via
`#plugins/*` (see [Conventions](/reference/conventions/#local-requires-subpath-imports))
and (b) wrap third-party calls in the hook with `try/catch` so a
remote outage doesn't crash an `afterCreate`.

### React to schema hot-reloads

In dev, schemas can be loaded / unloaded at runtime. Subscribe
via `onChange`:

```js
async setup({ schemaLoader, log }) {
  schemaLoader.onChange(() => {
    log.info({ schemas: schemaLoader.listSchemas() }, 'schemas changed');
    // rebuild whatever per-resource state your plugin maintains
  });
}
```

## Event bus

The same `EventEmitter` the [webhook dispatcher](/features/webhooks/)
subscribes to — your plugin and outbound webhooks see the same
events. The event shape:

```js
// Single-record events (POST, PUT-by-id, DELETE-by-id, GraphQL *One / *ById)
{
  type:     'order.created' | 'order.updated' | 'order.deleted' | 'order.transitioned',
  version:  'v1',
  userId:   '<tenant>',
  recordId: '<doc-id>',
  record:   { /* ACL-projected record */ },
}

// Bulk events (REST bulk PUT, GraphQL updateMany / removeMany)
{
  type:        'order.updated' | 'order.deleted',
  version:     'v1',
  userId:      '<tenant>',
  filter:      { /* the query that matched */ },
  numAffected: 47,
}

// State-machine transition (also fires the regular updated event)
{
  type:     'order.transitioned',
  version:  'v1',
  userId:   '<tenant>',
  recordId: '<doc-id>',
  field:    'status',
  from:     'draft',
  to:       'approved',
}
```

Bus subscribers are synchronous-to-the-emit but asynchronous-to-the-response —
the emit happens before the response is sent, and the handler
runs on the event loop after. A throwing handler does **not**
fail the originating request, but it will surface as an
unhandledRejection if you don't catch it. Always wrap async
handlers in a try/catch or `.catch(log.error)`.

The bus has `setMaxListeners(0)` — attach as many handlers as
you need without the "possible memory leak" warning.

## Errors and failure handling

### Boot-time failures

A throw inside `setup` fails the process. This is deliberate:
silently dropping a plugin would hide misconfiguration from
operators. If your plugin can't reach a downstream service at
boot, decide:

- **Fatal**: throw — the operator will see the boot failure and act.
- **Recoverable**: log a warning, schedule a retry, let `setup` resolve. The plugin's own routes still work.

### Runtime failures inside plugin routes

Plugin-mounted routes wrap into the same middleware chain as
schema-generated routes. After every plugin finishes, the
framework calls `schemaLoader.moveErrorHandlerToEnd()` — the
terminal `errorHandler` is re-spliced to the tail of the stack
so a thrown error in your route produces the standard JSON
response shape:

```json
{ "error": { "code": "...", "message": "..." } }
```

Throw the typed errors from `davepi/utils/errors` (or `next(err)`
inside an Express handler) and you get the right status code.

### Runtime failures inside event handlers

Event-bus handlers run outside the request lifecycle. The
framework can't surface a thrown error to the client — it's
already gone. **Always** wrap handlers:

```js
bus.on('record', async (event) => {
  try {
    await heavySideEffect(event);
  } catch (err) {
    log.error({ err, event }, 'plugin event handler failed');
  }
});
```

## Distributing a plugin as an npm package

A plugin is just a Node module. To publish one:

1. Name the package `davepi-plugin-<thing>` by convention.
2. Make `main` (or the file `package.json` points at via `exports`) export the `{ name, setup }` object.
3. Document the env vars / config your plugin needs in its README.
4. Add `davepi` as a `peerDependency` so consumers control the version.

Consumers install your package and add it to their
`davepi.plugins` list:

```bash
npm install davepi-plugin-slack
```

```json
{
  "davepi": {
    "plugins": ["davepi-plugin-slack"]
  }
}
```

## Tests

A plugin is straightforward to test — `loadPlugins` accepts an
inline object as well as a specifier string:

```js
const { loadPlugins } = require('davepi/utils/pluginLoader');
const { bus } = require('davepi/utils/events');

test('my plugin subscribes to order.created', async () => {
  const seen = [];
  await loadPlugins({
    plugins: [{
      name: 'test',
      setup: ({ bus }) => bus.on('record', (e) => seen.push(e.type)),
    }],
    app, schemaLoader, bus, appName: 'test',
  });
  // ... trigger an order.created and assert seen.includes('order.created')
});
```

See [`test/plugins.test.js`](https://github.com/projik/davepi/blob/main/test/plugins.test.js)
in the repo for a complete example.

## What plugins do NOT do

- **They don't gate schema loading.** A plugin can't reject a schema or rewrite it. If you need that, intercept at the schema-file level — plugins run after the registry is built.
- **They don't proxy GraphQL.** The Apollo router is built once per `rebuildGraphQL` call from the registry. To extend the GraphQL surface, declare what you need on a schema file (computed fields, aggregations, relations) — the registry rebuilds and the new resolvers appear automatically. A plugin can mount REST routes for cross-resource queries, but it can't inject GraphQL types into the auto-generated schema today.
- **They don't run scheduled jobs by themselves.** If you need cron, set up `node-schedule` (or similar) inside your `setup` and store the handle so it survives plugin teardown. The framework doesn't manage timers for you.

## See also

- [Hooks](/features/hooks/) — per-resource lifecycle hooks; the right tool for invariants that live on one schema.
- [Webhooks](/features/webhooks/) — outbound HTTP fan-out for tenants. Same event bus underneath.
- [Conventions](/reference/conventions/) — where to put new code in your project.
