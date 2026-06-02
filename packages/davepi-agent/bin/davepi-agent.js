#!/usr/bin/env node
'use strict';

/**
 * @davepi/agent — bootable chat agent for a dAvePi backend.
 *
 * Reads config from environment (see lib/config.js for the full
 * list) and starts HTTP /chat plus, if SLACK_BOT_TOKEN is set,
 * the Slack channel. Either channel can be disabled with
 * AGENT_HTTP_ENABLED=false / SLACK_ENABLED=false.
 *
 * Required env at minimum:
 *   DAVEPI_URL                 — base URL of the davepi backend
 *   ANTHROPIC_API_KEY or OPENAI_API_KEY — depending on LLM_PROVIDER
 *     (not needed for LLM_PROVIDER=ollama, which talks to a local Ollama server)
 *   DAVEPI_BEARER or DAVEPI_CLIENT_ID — for service auth mode
 *     OR
 *   AGENT_AUTH_MODE=per-user + AGENT_LINK_BASE_URL — for per-user mode
 */

const path = require('node:path');

const HELP = `Usage: davepi-agent [--help]

Boots the chat agent against a dAvePi backend. All configuration is
via environment variables — see the README and lib/config.js for
the full list. Quick start:

  DAVEPI_URL=http://localhost:5050 \\
  ANTHROPIC_API_KEY=sk-ant-... \\
  DAVEPI_BEARER=eyJ... \\
    npx -y @davepi/agent

Channels:
  HTTP   /chat        always on unless AGENT_HTTP_ENABLED=false
  Slack               on when SLACK_BOT_TOKEN is set

Auth modes (AGENT_AUTH_MODE):
  service  (default) DAVEPI_BEARER or DAVEPI_CLIENT_ID
  per-user            requires AGENT_LINK_BASE_URL + STORE_URL

LLM providers (LLM_PROVIDER):
  anthropic (default) needs ANTHROPIC_API_KEY
  openai              needs OPENAI_API_KEY
  ollama              local; needs LLM_MODEL (e.g. llama3.1);
                      OLLAMA_BASE_URL optional (default http://localhost:11434/v1)

Documentation: https://docs.davepi.dev/surfaces/agent/
`;

function err(msg) {
  process.stderr.write(`davepi-agent: ${msg}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  try {
    require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
  } catch {
    /* dotenv optional */
  }

  const { startAgent } = require('..');
  try {
    const handles = await startAgent();
    const onShutdown = async (signal) => {
      process.stderr.write(`davepi-agent: received ${signal}, shutting down...\n`);
      try {
        if (handles.http?.server) {
          await new Promise((resolve) => handles.http.server.close(() => resolve()));
        }
        await handles.auth.close?.();
      } catch (e) {
        process.stderr.write(`davepi-agent: shutdown error ${e.message}\n`);
      }
      process.exit(0);
    };
    process.on('SIGINT', () => onShutdown('SIGINT'));
    process.on('SIGTERM', () => onShutdown('SIGTERM'));
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

main();
