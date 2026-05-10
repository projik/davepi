#!/usr/bin/env node
/**
 * @davepi/mcp — one-line MCP wiring for a dAvePi instance.
 *
 * Two modes, picked by environment:
 *
 *   HTTP-proxy (DAVEPI_URL set)
 *     The wrapper runs as the agent's MCP server (stdio JSON-RPC)
 *     and forwards every message to the remote dAvePi's /mcp HTTP
 *     endpoint with `Authorization: Bearer ${DAVEPI_TOKEN}`. Use
 *     when the dAvePi instance is hosted (demo.davepi.dev,
 *     production deployment, etc.) and the agent runs on a
 *     developer's laptop.
 *
 *   Local-stdio (DAVEPI_SCHEMAS set, DAVEPI_URL unset)
 *     The wrapper spawns `davepi mcp` from the project's locally
 *     installed `davepi` package and pipes its stdio. Use when
 *     dAvePi is installed in the same project as the agent's
 *     working tree. This mode requires the project to have
 *     `davepi` as a dependency; we surface a helpful error if the
 *     binary can't be found.
 *
 * Both modes are pure stdio JSON-RPC pumps — neither holds any
 * MCP-protocol state of its own, so a future MCP version doesn't
 * require touching this package.
 */

'use strict';

const path = require('path');

const HELP = `Usage: davepi-mcp

Pick one mode by environment:

  HTTP-proxy mode:
    DAVEPI_URL    URL of the dAvePi server (e.g. https://api.example.com)
    DAVEPI_TOKEN  Long-lived JWT issued by /login on that server

  Local-stdio mode:
    DAVEPI_SCHEMAS  Path to schema/versions/ (defaults to ./schema/versions)

Examples:

  # Wire an agent to a hosted dAvePi:
  DAVEPI_URL=https://api.example.com DAVEPI_TOKEN=eyJ... npx -y @davepi/mcp

  # Wire an agent to local schemas (project must have \`davepi\` installed):
  DAVEPI_SCHEMAS=./schema/versions npx -y @davepi/mcp

Documentation: https://docs.davepi.dev/surfaces/mcp/
`;

function err(msg) {
  process.stderr.write(`davepi-mcp: ${msg}\n`);
}

function help() {
  process.stderr.write(HELP);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    help();
    process.exit(0);
  }

  const url = process.env.DAVEPI_URL;
  const schemas = process.env.DAVEPI_SCHEMAS;

  if (url) {
    if (!process.env.DAVEPI_TOKEN) {
      err('DAVEPI_URL is set but DAVEPI_TOKEN is missing. Set both for HTTP-proxy mode.');
      help();
      process.exit(1);
    }
    const { runHttpProxy } = require(path.join('..', 'lib', 'http-proxy.js'));
    return runHttpProxy({
      url,
      token: process.env.DAVEPI_TOKEN,
    });
  }

  if (schemas || args.length === 0) {
    // Local-stdio mode. Schemas path defaults to ./schema/versions
    // (the davepi convention) so a user with a project structured
    // the standard way can omit DAVEPI_SCHEMAS entirely.
    const { runLocalStdio } = require(path.join('..', 'lib', 'local-stdio.js'));
    return runLocalStdio({
      schemas: schemas || path.join(process.cwd(), 'schema', 'versions'),
    });
  }

  help();
  process.exit(1);
}

main().catch((e) => {
  err(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
