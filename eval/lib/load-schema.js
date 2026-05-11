/**
 * Sandboxed schema loader. Used by every prompt's check.js to read
 * the agent's output without granting it host privileges.
 *
 * Why this exists: nightly CI runs with `ANTHROPIC_API_KEY` in the
 * environment. If a check.js did `require()` on the agent-produced
 * schema file, any top-level side effect in that file (e.g.
 * `require('child_process').exec(...)` exfiltrating an env var)
 * would run in the same process that has the API key. The agent
 * isn't expected to be malicious, but the eval shouldn't trust its
 * output either — these are tests, not the framework runtime.
 *
 * The sandbox evaluates the schema file in a fresh vm context with:
 *   - NO `require`, `process`, `globalThis`, or other Node globals.
 *   - Only the type sentinels Mongoose schemas legitimately use
 *     (String, Number, Boolean, Date, Array, RegExp, Object).
 *   - A `module` + `exports` pair so the CommonJS `module.exports =
 *     { ... }` idiom works.
 *
 * Computed-field functions returned from the sandbox keep their
 * vm context as their lexical scope, so calling them from check.js
 * doesn't escape — they still see only the sandboxed globals.
 *
 * Trade-offs: schemas that legitimately `require()` other modules
 * (e.g. to share helpers) won't load. That's fine for eval — the
 * agent only writes pure-data schema files.
 */

'use strict';

const fs = require('node:fs');
const vm = require('node:vm');

function loadSchemaSandboxed(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const moduleStub = { exports: {} };
  const sandbox = {
    module: moduleStub,
    exports: moduleStub.exports,
    // Mongoose schemas reference these as type sentinels; without
    // them the schema file would `ReferenceError` before it could
    // export anything useful.
    String, Number, Boolean, Date, Array, RegExp, Object,
  };
  // 2-second timeout caps any infinite loop in the schema file.
  // Even though agents shouldn't produce one, this keeps the eval
  // from hanging CI on a pathological output.
  vm.runInNewContext(source, sandbox, {
    filename: filePath,
    timeout: 2000,
  });
  return moduleStub.exports;
}

module.exports = { loadSchemaSandboxed };
