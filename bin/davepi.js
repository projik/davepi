#!/usr/bin/env node
require('dotenv').config();

const path = require('path');
const mongoose = require('mongoose');

const { diffVersions, formatDiff } = require('../utils/migrations/diff');
const { writeScaffold } = require('../utils/migrations/scaffold');
const {
  status,
  migrateUp,
  migrateDown,
} = require('../utils/migrations/runner');
const logger = require('../utils/logger');

/**
 * CLI output policy:
 *
 *   - The PROJECT-WIDE rule (CLAUDE.md) is "use utils/logger, never
 *     console.*". That rule exists to keep request-scoped log lines
 *     correlatable and redactable. CLIs are different: stdout/stderr
 *     ARE the user interface, and structured `INFO (1234): foo`
 *     prefixes read terribly when you're piping output into a shell.
 *   - So this binary uses `process.stdout` / `process.stderr` for
 *     human-facing output (results, status), and `logger` for
 *     unexpected-error diagnostics that an operator might want to
 *     correlate across runs.
 *
 * Treat this file's `process.stdout.write` calls as the documented
 * exception, not a precedent for app code.
 */
const out = (line) => process.stdout.write(line + '\n');
const err = (line) => process.stderr.write(line + '\n');

function usage() {
  out(`Usage: davepi <command> [args]

Commands:
  diff <fromVersion> <toVersion>           Print field-level changes
  migration:create <name> [--from <v>] [--to <v>]
                                            Scaffold a migration file. With
                                            --from/--to, the body is pre-filled
                                            from the schema diff.
  migrate [--dry]                          Apply pending migrations
  migrate:down [--dry]                     Revert the most recently applied
  migrate:status                           List pending vs applied
  gen-client --out <file> [--base-url <url>]
                                            Emit a TypeScript client for
                                            every loaded schema. Pairs with
                                            client/davepi-runtime.ts. Output
                                            is deterministic so CI diffs
                                            stay clean.
  mcp                                      Run an MCP server over stdio.
                                            Requires DAVEPI_TOKEN (a JWT
                                            issued by the same TOKEN_KEY) so
                                            tools execute as a real user.`);
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] || true;
}

async function withDb(run) {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    err('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);
  try {
    return await run(mongoose.connection.db);
  } finally {
    await mongoose.disconnect();
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === 'diff') {
    const [fromV, toV] = rest;
    if (!fromV || !toV) {
      err('diff requires <fromVersion> <toVersion>');
      process.exit(1);
    }
    const root = path.resolve('./schema/versions');
    const diff = diffVersions(path.join(root, fromV), path.join(root, toV));
    out(formatDiff(diff));
    return;
  }

  if (cmd === 'migration:create') {
    const name = rest.find((a) => !a.startsWith('--'));
    if (!name) {
      err('migration:create requires a <name>');
      process.exit(1);
    }
    const fromV = flag(rest, '--from');
    const toV = flag(rest, '--to');
    const file = writeScaffold({
      name,
      fromVersion: typeof fromV === 'string' ? fromV : null,
      toVersion: typeof toV === 'string' ? toV : null,
    });
    out(`Created ${path.relative(process.cwd(), file)}`);
    return;
  }

  if (cmd === 'migrate') {
    const dry = !!flag(rest, '--dry');
    await withDb(async (db) => {
      const ran = await migrateUp({ db, dry });
      if (ran.length === 0) {
        out('No pending migrations.');
      } else {
        for (const r of ran) {
          out(`${dry ? '[DRY] ' : ''}applied ${r.name} (${r.durationMs}ms)`);
        }
      }
    });
    return;
  }

  if (cmd === 'migrate:down') {
    const dry = !!flag(rest, '--dry');
    await withDb(async (db) => {
      const r = await migrateDown({ db, dry });
      if (!r) {
        out('No applied migrations to revert.');
      } else {
        out(`${dry ? '[DRY] ' : ''}reverted ${r.name}`);
      }
    });
    return;
  }

  if (cmd === 'gen-client') {
    const outPath = flag(rest, '--out');
    if (!outPath || outPath === true) {
      err('gen-client requires --out <file>');
      process.exit(1);
    }
    const baseUrlFlag = flag(rest, '--base-url');
    const baseUrl = typeof baseUrlFlag === 'string' ? baseUrlFlag : '';
    // Boot the regular app so schemas / models / the loader come up
    // exactly as they would for the HTTP server, then read the
    // registry to drive generation. We never call app.listen — the
    // process exits after writing the file.
    require('../config/database').connect();
    const app = require('../app');
    let appReady = false;
    try {
      if (app.locals && app.locals.ready) await app.locals.ready;
      appReady = true;
      const { generateClient } = require('../utils/clientGen');
      const entries = [];
      for (const key of app.locals.schemaLoader.listSchemas()) {
        const e = app.locals.schemaLoader.getEntry(key);
        if (e && e.schema) entries.push({ s: e.schema });
      }
      const ts = generateClient(entries, { baseUrl });
      require('fs').writeFileSync(path.resolve(outPath), ts);
      out(
        `Wrote ${path.relative(process.cwd(), path.resolve(outPath))} (${entries.length} schemas)`
      );
    } finally {
      // Cleanup runs on success AND failure so the process exits
      // cleanly. The schema watcher (when HOT_RELOAD_SCHEMAS is on)
      // uses chokidar, which keeps the event loop alive; we have to
      // stop it explicitly. Mongoose disconnect always runs to drop
      // the open connection.
      if (
        appReady &&
        app.locals &&
        app.locals.schemaWatcher &&
        typeof app.locals.schemaWatcher.stop === 'function'
      ) {
        try { await app.locals.schemaWatcher.stop(); } catch (_) {}
      }
      try { await require('mongoose').disconnect(); } catch (_) {}
    }
    return;
  }

  if (cmd === 'mcp') {
    // stdio MCP server bound to a long-lived JWT. We boot the regular
    // app (so schemas, models, and the loader are wired exactly the
    // same way as the HTTP path) but never call app.listen — the
    // process's I/O is the MCP transport, not HTTP.
    const jwt = require('jsonwebtoken');
    const token = process.env.DAVEPI_TOKEN;
    if (!token) {
      err('mcp: DAVEPI_TOKEN env var is required');
      process.exit(1);
    }
    if (!process.env.TOKEN_KEY) {
      err('mcp: TOKEN_KEY env var is required to verify DAVEPI_TOKEN');
      process.exit(1);
    }
    let user;
    try {
      user = jwt.verify(token, process.env.TOKEN_KEY);
    } catch (verifyErr) {
      err(`mcp: DAVEPI_TOKEN is invalid (${verifyErr.message})`);
      process.exit(1);
    }
    require('../config/database').connect();
    const app = require('../app');
    if (app.locals && app.locals.ready) await app.locals.ready;
    const { buildMcpServer } = require('../utils/mcpServer');
    const {
      StdioServerTransport,
    } = require('@modelcontextprotocol/sdk/server/stdio.js');
    const server = buildMcpServer({
      schemaLoader: app.locals.schemaLoader,
      getUser: () => user,
      name: process.env.APP_NAME || 'davepi',
      // stdio is long-lived — refresh tools when the schema watcher
      // reloads so connected clients see new resources without
      // restarting the process.
      liveReload: true,
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Park indefinitely — the SDK keeps the process alive via stdin.
    return new Promise(() => {});
  }

  if (cmd === 'migrate:status') {
    await withDb(async (db) => {
      const items = await status({ db });
      if (items.length === 0) {
        out('No migrations on disk.');
        return;
      }
      for (const it of items) {
        out(`${it.applied ? '[applied]' : '[pending]'} ${it.name}`);
      }
    });
    return;
  }

  usage();
  process.exit(1);
}

main().catch((unexpected) => {
  // Unexpected failures route through the structured logger so an
  // operator running this from a wrapper script gets a JSON line in
  // production. The user-facing message also goes to stderr so the
  // shell sees a clean failure summary.
  logger.error({ err: unexpected }, 'davepi CLI failed');
  err(unexpected && unexpected.message ? unexpected.message : String(unexpected));
  process.exit(1);
});
