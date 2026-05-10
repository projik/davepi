/**
 * Local-stdio mode tests. We don't actually spawn `davepi mcp` (that
 * would boot Mongo); we just verify the bin-resolution logic and the
 * error path when davepi isn't installed.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { findDavepiBin } = require('../lib/local-stdio');

test('findDavepiBin: prefers a project-local node_modules/.bin/davepi', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-mcp-'));
  const bin = path.join(tmp, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  const fakeBin = path.join(bin, 'davepi');
  fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeBin, 0o755);

  const original = process.cwd();
  try {
    process.chdir(tmp);
    assert.equal(findDavepiBin(), fakeBin);
  } finally {
    process.chdir(original);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findDavepiBin: falls back to bare `davepi` for PATH lookup when no local install', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-mcp-'));
  const original = process.cwd();
  try {
    process.chdir(tmp);
    assert.equal(findDavepiBin(), 'davepi');
  } finally {
    process.chdir(original);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
