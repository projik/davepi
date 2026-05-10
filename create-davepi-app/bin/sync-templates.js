#!/usr/bin/env node
/**
 * Pre-publish hook: copy `templates/` from the dAvePi monorepo
 * root into this package's directory so the published tarball
 * carries the templates and consumers don't need a working
 * monorepo layout to scaffold.
 *
 * The runtime CLI (`bin/index.js`) prefers a sibling `templates/`
 * inside the package; this script populates that sibling. In dev
 * (running tests, working in the monorepo) the CLI falls back to
 * `../../templates` instead.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', '..', 'templates');
const dest = path.resolve(__dirname, '..', 'templates');

if (!fs.existsSync(src)) {
  process.stderr.write(
    `sync-templates: ${src} not found. Run from inside the dAvePi monorepo.\n`
  );
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });

function copyTree(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
    const a = path.join(s, entry.name);
    const b = path.join(d, entry.name);
    if (entry.isDirectory()) copyTree(a, b);
    else fs.copyFileSync(a, b);
  }
}

copyTree(src, dest);
process.stdout.write(`sync-templates: copied ${src} → ${dest}\n`);
