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

function usage() {
  console.log(`Usage: davepi <command> [args]

Commands:
  diff <fromVersion> <toVersion>           Print field-level changes
  migration:create <name> [--from <v>] [--to <v>]
                                            Scaffold a migration file. With
                                            --from/--to, the body is pre-filled
                                            from the schema diff.
  migrate [--dry]                          Apply pending migrations
  migrate:down [--dry]                     Revert the most recently applied
  migrate:status                           List pending vs applied
`);
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] || true;
}

async function withDb(run) {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
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
      console.error('diff requires <fromVersion> <toVersion>');
      process.exit(1);
    }
    const root = path.resolve('./schema/versions');
    const diff = diffVersions(path.join(root, fromV), path.join(root, toV));
    console.log(formatDiff(diff));
    return;
  }

  if (cmd === 'migration:create') {
    const name = rest.find((a) => !a.startsWith('--'));
    if (!name) {
      console.error('migration:create requires a <name>');
      process.exit(1);
    }
    const fromV = flag(rest, '--from');
    const toV = flag(rest, '--to');
    const file = writeScaffold({
      name,
      fromVersion: typeof fromV === 'string' ? fromV : null,
      toVersion: typeof toV === 'string' ? toV : null,
    });
    console.log(`Created ${path.relative(process.cwd(), file)}`);
    return;
  }

  if (cmd === 'migrate') {
    const dry = !!flag(rest, '--dry');
    await withDb(async (db) => {
      const ran = await migrateUp({ db, dry });
      if (ran.length === 0) {
        console.log('No pending migrations.');
      } else {
        for (const r of ran) {
          console.log(`${dry ? '[DRY] ' : ''}applied ${r.name} (${r.durationMs}ms)`);
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
        console.log('No applied migrations to revert.');
      } else {
        console.log(`${dry ? '[DRY] ' : ''}reverted ${r.name}`);
      }
    });
    return;
  }

  if (cmd === 'migrate:status') {
    await withDb(async (db) => {
      const items = await status({ db });
      if (items.length === 0) {
        console.log('No migrations on disk.');
        return;
      }
      for (const it of items) {
        console.log(`${it.applied ? '[applied]' : '[pending]'} ${it.name}`);
      }
    });
    return;
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
