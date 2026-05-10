/**
 * Local-stdio mode: spawn `davepi mcp` from the user's local install
 * and pipe stdio through unchanged.
 *
 * Why spawn vs in-process: requiring `davepi` directly would boot
 * Mongo, Apollo, and Express in this process — a lot of side effects
 * for a wrapper that just brokers stdio. The davepi CLI already does
 * the right thing in its own process; we just inherit fds.
 *
 * Resolution order for the davepi binary:
 *   1. ./node_modules/.bin/davepi (the project's local install)
 *   2. PATH (a globally installed davepi)
 *
 * If neither resolves, surface a helpful error pointing the user at
 * `npm install davepi` rather than a cryptic ENOENT.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function findDavepiBin() {
  // 1. Project-local install. Honour the standard node_modules/.bin
  //    layout first — that's what the user gets after `npm install
  //    davepi` in their dAvePi project.
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'davepi');
  if (fs.existsSync(local)) return local;

  // Windows ships .cmd shims for the JS launcher; check that too.
  const localCmd = path.join(process.cwd(), 'node_modules', '.bin', 'davepi.cmd');
  if (fs.existsSync(localCmd)) return localCmd;

  // 2. Fall back to PATH — a globally installed davepi.
  return 'davepi';
}

function runLocalStdio({ schemas } = {}) {
  const bin = findDavepiBin();
  const env = { ...process.env };
  // davepi's bin reads schema/versions from the project root by
  // default. If the user pointed somewhere non-standard via
  // DAVEPI_SCHEMAS, propagate it.
  if (schemas) env.DAVEPI_SCHEMAS = schemas;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['mcp'], {
      stdio: 'inherit',
      env,
      // Windows needs shell:true to pick up the .cmd shim if `bin`
      // is a bare name. Doesn't affect Unix where `bin` is a full path.
      shell: process.platform === 'win32',
    });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        process.stderr.write(
          'davepi-mcp: could not find the `davepi` binary. ' +
          'Install dAvePi in this project (`npm install davepi`) ' +
          'and try again, or set DAVEPI_URL to use HTTP-proxy mode.\n'
        );
        reject(err);
        return;
      }
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      // Mirror the child's exit code so CI / supervisors see the
      // real outcome.
      process.exit(code ?? 0);
    });

    // Forward signals to the child so Ctrl-C from the agent cleanly
    // terminates the davepi server.
    const forward = (sig) => () => {
      try { child.kill(sig); } catch (_) { /* already dead */ }
    };
    process.on('SIGINT', forward('SIGINT'));
    process.on('SIGTERM', forward('SIGTERM'));

    resolve();
  });
}

module.exports = { runLocalStdio, findDavepiBin };
