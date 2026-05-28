#!/usr/bin/env node
'use strict';

/**
 * Minimal smoke demo. Starts the agent's HTTP channel and serves a
 * tiny static page on the same port that opens an SSE stream to
 * /chat. Used as the "did v1 actually ship" gate — run this against
 * a local davepi and confirm tool calls land, text streams, and the
 * render tools produce visible tables/charts.
 *
 * Usage:
 *   DAVEPI_URL=http://localhost:5050 \
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   DAVEPI_BEARER=eyJ... \
 *     npm run demo
 *
 *   Open http://localhost:5060/demo/
 */

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const { startAgent } = require('..');

async function main() {
  const handles = await startAgent();
  const { app } = handles.http;
  app.use('/demo', express.static(path.join(__dirname)));
  process.stderr.write('\nDemo page: http://localhost:5060/demo/index.html\n');
  process.stderr.write('Backend:   ' + handles.config.davepiUrl + '\n');
}

main().catch((err) => {
  process.stderr.write(`demo failed: ${err.message}\n`);
  process.exit(1);
});
