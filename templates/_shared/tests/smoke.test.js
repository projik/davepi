/**
 * Smoke tests for the project's schema files.
 *
 * Validates each file under `schema/versions/v1/` parses cleanly,
 * exports a `path` + `fields` shape, and includes the framework's
 * required `userId` tenant column. Doesn't need MongoDB — this is
 * a fast guard against typos that would otherwise only surface
 * when the server boots in production.
 *
 * Uses node:test (built-in, no extra deps). Add your own
 * integration tests alongside this file as the project grows.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schemaDir = path.join(__dirname, '..', 'schema', 'versions', 'v1');
const files = fs.existsSync(schemaDir)
  ? fs.readdirSync(schemaDir).filter((f) => f.endsWith('.js'))
  : [];

test('schema directory exists and contains at least one schema file', () => {
  assert.ok(
    fs.existsSync(schemaDir),
    'expected ./schema/versions/v1/ to exist'
  );
  assert.ok(
    files.length > 0,
    'expected at least one schema file under ./schema/versions/v1/'
  );
});

for (const file of files) {
  test(`${file}: exports a valid schema shape`, () => {
    // require() will throw on a syntax error or a missing CommonJS
    // export — both of which we want to catch in CI before deploy.
    const schema = require(path.join(schemaDir, file));

    assert.equal(typeof schema, 'object', `${file} must export an object`);
    assert.equal(
      typeof schema.path,
      'string',
      `${file}: schema.path must be a string`
    );
    assert.ok(schema.path.length > 0, `${file}: schema.path must be non-empty`);
    assert.ok(Array.isArray(schema.fields), `${file}: schema.fields must be an array`);
    assert.ok(
      schema.fields.length > 0,
      `${file}: schema.fields must have at least one entry`
    );

    const userIdField = schema.fields.find((f) => f && f.name === 'userId');
    assert.ok(
      userIdField,
      `${file}: every schema must declare a 'userId' field — the framework stamps it as the tenant column`
    );
    assert.equal(
      userIdField.required,
      true,
      `${file}: 'userId' must be required: true`
    );
  });
}
