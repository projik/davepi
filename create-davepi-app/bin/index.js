#!/usr/bin/env node
/**
 * `npx create-davepi-app <name> [--template blank|crm|ticketing|content]`
 *
 * Scaffolds a new dAvePi project: copies the chosen template's
 * schema files into the target directory, generates a package.json
 * pinned to the latest dAvePi, writes a `.env` with secure defaults,
 * pre-configures `.mcp.json` for Claude Code, and prints the next
 * three commands the user should run.
 *
 * Stays small on purpose: no `inquirer`, no fancy progress bars —
 * the goal is "from cold install to running with auth + sample
 * data" in under a minute, and the fewer failure modes the better.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const TEMPLATES = ['blank', 'crm', 'ticketing', 'content', 'b2b-saas'];

function out(line) {
  process.stdout.write(line + '\n');
}
function err(line) {
  process.stderr.write(line + '\n');
}

/**
 * Read a `--name <value>` flag from argv. Returns:
 *   - null   when the flag isn't present
 *   - true   when the flag is present with no following token
 *            (treated as a boolean flag — e.g., --no-install)
 *   - string when the flag has a non-flag value following it
 *
 * Throws when the next token starts with `--` (e.g.,
 * `--davepi-version --no-install` would otherwise pin davepi to
 * "--no-install" and silently produce an un-installable project).
 */
function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const next = args[i + 1];
  if (next === undefined) return true;
  if (typeof next === 'string' && next.startsWith('--')) {
    const errFn = require('util').inspect;
    const e = new Error(
      `Flag ${name} requires a value (got ${errFn(next)}, which looks like another flag).`
    );
    e.usage = true;
    throw e;
  }
  return next;
}

/**
 * Find an unused TCP port near the requested starting port. Tries
 * ports sequentially up to `maxAttempts` apart so the scaffolded
 * .env carries a value the user can probably bind to. The check is
 * advisory — by the time `npm start` runs, another process could
 * have grabbed the port — but it dramatically reduces "tutorial
 * fails because port 5050 is in use" failures.
 */
async function pickPort(start = 5050, maxAttempts = 20) {
  for (let p = start; p < start + maxAttempts; p++) {
    if (await isPortFree(p)) return p;
  }
  // Fall back to OS-assigned (port 0) to guarantee something works.
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

function usage() {
  out(`Usage: npx create-davepi-app <name> [--template <name>] [--no-install]

Templates:
  blank      Minimal — one resource, full-text search.
  crm        Accounts / contacts / deals (state machine) / activities.
  ticketing  Tickets (status + priority state machines) / comments.
  content    Articles (editorial workflow) / categories / file uploads.
  b2b-saas   Orgs / workspaces / invites (state machine) / billingEvent (aggregations).

Examples:
  npx create-davepi-app my-app
  npx create-davepi-app my-crm --template crm
  npx create-davepi-app my-app --template blank --no-install`);
}

/**
 * Resolve the templates directory. When the package is installed
 * from npm, templates live alongside `bin/` in the package itself.
 * In the dAvePi monorepo (during dev / tests), templates live at
 * the repo root one level up. Try both.
 */
function templatesDir() {
  const local = path.resolve(__dirname, '..', 'templates');
  if (fs.existsSync(local)) return local;
  const monorepo = path.resolve(__dirname, '..', '..', 'templates');
  if (fs.existsSync(monorepo)) return monorepo;
  throw new Error(
    'Cannot find templates directory. Reinstall create-davepi-app.'
  );
}

function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}

function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

async function scaffold({ name, template, install, davepiVersion, port }) {
  const target = path.resolve(name);
  if (fs.existsSync(target)) {
    const empty = fs.readdirSync(target).length === 0;
    if (!empty) {
      throw new Error(
        `Target directory ${target} already exists and is not empty.`
      );
    }
  } else {
    fs.mkdirSync(target, { recursive: true });
  }

  if (!TEMPLATES.includes(template)) {
    throw new Error(
      `Unknown template '${template}'. Allowed: ${TEMPLATES.join(', ')}`
    );
  }

  // 1. Schemas + template README
  copyTree(path.join(templatesDir(), template), target);

  // 2. package.json — pin dAvePi as a runtime dep.
  writeJson(path.join(target, 'package.json'), {
    name,
    version: '0.1.0',
    private: true,
    description: `${name} — built on dAvePi (${template} template).`,
    scripts: {
      // The consumer's index.js is just `require('davepi')` — that
      // boots the server with the consumer's schemas/versions/.
      start: 'node index.js',
      dev: 'node index.js',
      // Each template ships a `seed.js` that registers a demo user
      // and POSTs sample records. Run AFTER `npm start` is up in
      // another terminal.
      seed: 'node seed.js',
      'gen-client': 'davepi gen-client --out client/davepi.ts',
      'mcp:stdio': 'davepi mcp',
    },
    dependencies: {
      davepi: davepiVersion || 'latest',
    },
  });

  // 3. index.js — the consumer's entry point.
  fs.writeFileSync(
    path.join(target, 'index.js'),
    "// Boots the dAvePi server using this project's schema/versions/* files.\n" +
    "// Add custom routes here AFTER the require, using `app.locals.schemaLoader`.\n" +
    "require('davepi');\n"
  );

  // 4. .env — random TOKEN_KEY (NEVER use the default in prod), local Mongo defaults.
  // Port was probed for availability before scaffolding so the
  // user lands on something they can actually bind to.
  const apiPort = port || (await pickPort());
  fs.writeFileSync(
    path.join(target, '.env'),
    [
      `# Generated by create-davepi-app. Don't commit this file.`,
      `MONGO_URI=mongodb://127.0.0.1:27017/${name.replace(/[^A-Za-z0-9_-]/g, '_')}`,
      `TOKEN_KEY=${randomSecret()}`,
      `API_PORT=${apiPort}`,
      `PAGE_SIZE=20`,
      `CORS_ORIGINS=http://localhost:3000,http://localhost:5173`,
      `# Set HOT_RELOAD_SCHEMAS=true in dev to pick up schema/versions/* changes live.`,
      `HOT_RELOAD_SCHEMAS=true`,
      `NODE_ENV=development`,
      ``,
    ].join('\n')
  );

  // 5. .gitignore
  fs.writeFileSync(
    path.join(target, '.gitignore'),
    ['node_modules', '.env', 'uploads', 'client/davepi.ts', ''].join('\n')
  );

  // 6. .mcp.json — Claude Code wiring out of the box.
  writeJson(path.join(target, '.mcp.json'), {
    mcpServers: {
      davepi: {
        command: 'npx',
        args: ['davepi', 'mcp'],
        env: {
          MONGO_URI: 'mongodb://127.0.0.1:27017/' + name.replace(/[^A-Za-z0-9_-]/g, '_'),
          TOKEN_KEY: '<paste-the-TOKEN_KEY-from-.env-here>',
          DAVEPI_TOKEN:
            '<run `npm start`, register a user, then paste the accessToken here>',
        },
      },
    },
  });

  // 7. agent.md — drop-in agent instructions. Mirrored to .cursorrules
  // so Cursor users pick it up.
  const agentGuide = [
    '# Agent guide for this dAvePi project',
    '',
    'You are working inside a dAvePi project. dAvePi auto-generates REST,',
    'GraphQL, Swagger, and an MCP server from the schema files in',
    '`schema/versions/v1/*.js`. Hot-reload is enabled — drop a new schema',
    "file and the surface updates without restarting.",
    '',
    '## To add a resource',
    '',
    'Create `schema/versions/v1/<resource>.js` exporting a CommonJS object:',
    '',
    '```js',
    'module.exports = {',
    "  path: '<resource>',",
    "  collection: '<resource>',",
    '  fields: [',
    "    { name: 'userId', type: String, required: true },     // required on every schema",
    "    { name: 'title', type: String, required: true, searchable: true },",
    "    { name: 'priority', type: Number },",
    '  ],',
    '  // Optional: relations, computed, state machines, aggregations, file fields, ACL.',
    '  // See the framework docs and the existing schemas in this folder for examples.',
    '};',
    '```',
    '',
    '## Conventions',
    '',
    '- `userId` is required on every schema; the framework stamps it from the JWT.',
    '  Never set it manually.',
    '- `accountId` is also auto-stamped; if your schema needs a foreign key to a',
    "  parent account, name it `parentAccountId` (or anything other than 'accountId').",
    '- `type: \'File\'` fields are uploaded via dedicated multipart routes, never via JSON.',
    '- Computed fields are read-only and run at response time. Prefer them over',
    '  client-side derivation.',
    '- State machines reject undeclared transitions with `400 INVALID_TRANSITION`.',
    '  Use `record.availableTransitions[<field>]` to render the right UI buttons.',
    '- Aggregations always have `$match: { userId }` prepended automatically.',
    '',
    '## Surfaces available without writing handlers',
    '',
    '- REST: `GET / POST / PUT / DELETE /api/v1/<path>` plus `/:id`, `/:id/restore`,',
    '  `/:id/history`, file fields, aggregations.',
    '- GraphQL: `<path>Many`, `<path>ById`, `<path>CreateOne`, `<path>UpdateById`,',
    '  `<path>RemoveById`, etc.',
    '- MCP: `list_<path>`, `get_<path>`, `create_<path>`, `update_<path>`, `delete_<path>`,',
    '  plus restore/history/search/aggregations/transitions/file uploads as applicable.',
    `- Swagger: http://localhost:${apiPort}/api-docs`,
    `- Capability manifest: GET http://localhost:${apiPort}/_describe`,
    '',
    '## Common mistakes to avoid',
    '',
    '- Manually wiring `userId` in route handlers — the framework stamps it.',
    '- Using `accountId` as a custom foreign key name — it collides with the',
    '  framework\'s auto-stamping. Use `parentAccountId` or similar.',
    '- Forgetting `required: true` on `userId` in new schemas.',
    "- Writing custom CRUD routes when the auto-generated ones suffice.",
    '',
    '## Useful commands',
    '',
    '- `npm start` — boot the server.',
    '- `npx davepi gen-client --out client/davepi.ts` — regenerate the typed TS client.',
    '- `npx davepi migrate` — apply pending migrations.',
    '- `npx davepi mcp` — run the MCP server over stdio (used by `.mcp.json`).',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(target, 'agent.md'), agentGuide);
  fs.writeFileSync(path.join(target, '.cursorrules'), agentGuide);

  // 8. docker-compose.yml — local Mongo for dev.
  fs.writeFileSync(
    path.join(target, 'docker-compose.yml'),
    [
      '# Local Mongo for development. Run: docker compose up -d',
      'services:',
      '  mongo:',
      '    image: mongo:7',
      '    restart: unless-stopped',
      '    ports:',
      '      - "27017:27017"',
      '    volumes:',
      '      - mongo_data:/data/db',
      'volumes:',
      '  mongo_data: {}',
      '',
    ].join('\n')
  );

  // 9. README — project-level, not template-level. Renames the
  // template README to TEMPLATE.md so both survive.
  if (fs.existsSync(path.join(target, 'README.md'))) {
    fs.renameSync(
      path.join(target, 'README.md'),
      path.join(target, 'TEMPLATE.md')
    );
  }
  fs.writeFileSync(
    path.join(target, 'README.md'),
    [
      `# ${name}`,
      '',
      `Built on dAvePi (\`${template}\` template).`,
      '',
      '## Get running',
      '',
      '```bash',
      'docker compose up -d            # local Mongo',
      'npm install                     # install dAvePi',
      'npm start                       # boot the server',
      '```',
      '',
      'Then:',
      `- REST: http://localhost:${apiPort}/api/v1/...`,
      `- GraphQL: http://localhost:${apiPort}/graphql/`,
      `- Swagger: http://localhost:${apiPort}/api-docs`,
      `- Admin SPA: http://localhost:${apiPort}/admin (after \`npm run build:admin\` in node_modules/davepi)`,
      `- Capability manifest: http://localhost:${apiPort}/_describe`,
      '',
      '## What\'s in this template',
      '',
      `See [TEMPLATE.md](./TEMPLATE.md) for the schema walkthrough.`,
      '',
      '## With Claude Code / Cursor',
      '',
      'The MCP server is pre-configured in `.mcp.json` and the agent guide',
      'is at `agent.md` (mirrored to `.cursorrules`). Open the project in',
      "your editor and ask the agent to add a resource — schema files in",
      '`schema/versions/v1/` hot-reload as you save.',
      '',
      '## Regenerate the typed client',
      '',
      '```bash',
      'npm run gen-client',
      '```',
      '',
      'Output lands at `client/davepi.ts`. Pair with `client/davepi-runtime.ts`',
      "from dAvePi's source tree (or copy from `node_modules/davepi/client/`).",
      '',
    ].join('\n')
  );

  // 10. Done. Run npm install if requested.
  out(`\nScaffolded ${name} (template: ${template})`);
  if (install) {
    out('\nInstalling dependencies...');
    const { spawnSync } = require('child_process');
    const r = spawnSync('npm', ['install'], { cwd: target, stdio: 'inherit' });
    if (r.status !== 0) {
      err(
        `\nnpm install failed. Re-run manually: cd ${name} && npm install`
      );
      return target;
    }
  }

  out('');
  out(`Next steps:`);
  out(`  cd ${name}`);
  if (!install) out(`  npm install`);
  out(`  docker compose up -d   # start Mongo`);
  out(`  npm start              # http://localhost:${apiPort}`);
  out('');
  out(`Try Claude Code: open the project, the MCP server is wired in .mcp.json.`);
  return target;
}

async function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    err('Project name required.');
    usage();
    process.exit(1);
  }
  let template = 'blank';
  let davepiVersion = null;
  let port = null;
  try {
    const tplArg = flag(args, '--template');
    if (typeof tplArg === 'string') template = tplArg;
    const v = flag(args, '--davepi-version');
    if (typeof v === 'string') davepiVersion = v;
    const p = flag(args, '--port');
    if (typeof p === 'string' && /^\d+$/.test(p)) port = parseInt(p, 10);
  } catch (parseErr) {
    err(`\n${parseErr.message}`);
    usage();
    process.exit(1);
  }
  const noInstall = args.includes('--no-install');

  try {
    await scaffold({ name, template, install: !noInstall, davepiVersion, port });
  } catch (e) {
    err(`\nError: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv).catch((e) => {
    err(`\nError: ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  });
}

module.exports = { scaffold, TEMPLATES, flag, pickPort, isPortFree };
