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

const { findDavepiBin, runLocalStdio } = require('../lib/local-stdio');

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

test('runLocalStdio: spawn ENOENT rejects so the bin can exit non-zero', async () => {
  // Simulate the "davepi isn't installed" failure mode: cwd has no
  // node_modules/.bin/davepi, and the bare `davepi` isn't on PATH.
  // The previous implementation resolved the Promise immediately
  // and never propagated the ENOENT, so the bin would exit 0 even
  // though the MCP server never started — silent failure.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-mcp-'));
  const original = process.cwd();
  const originalPath = process.env.PATH;
  try {
    process.chdir(tmp);
    // Empty PATH so the spawn can't find any `davepi` executable.
    process.env.PATH = '';

    // Capture stderr (the helpful "could not find" message goes there).
    const writes = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };

    let caught;
    try {
      await runLocalStdio();
    } catch (err) {
      caught = err;
    } finally {
      process.stderr.write = realWrite;
    }

    assert.ok(caught, 'runLocalStdio should reject when davepi binary is missing');
    assert.equal(caught.code, 'ENOENT');
    assert.ok(
      writes.some((w) => /could not find the `davepi` binary/.test(w)),
      'should print the helpful install hint before rejecting'
    );
  } finally {
    process.env.PATH = originalPath;
    process.chdir(original);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
