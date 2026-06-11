'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getMagicLinkTokenModel } = require('../lib/models');

// Minimal mongoose stub: enough Schema/model surface to assert the
// definition without a real Mongo connection.
function stubMongoose() {
  class Schema {
    constructor(definition, options) {
      this.definition = definition;
      this.options = options;
      this.indexes = [];
    }
    index(fields, options) {
      this.indexes.push({ fields, options });
    }
  }
  Schema.Types = { Mixed: 'MIXED' };
  const m = {
    Schema,
    models: {},
    model(name, schema) {
      const model = { modelName: name, schema };
      m.models[name] = model;
      return model;
    },
  };
  return m;
}

test('getMagicLinkTokenModel: defines the hash-only, TTL-indexed token schema', () => {
  const mongoose = stubMongoose();
  const model = getMagicLinkTokenModel(mongoose);

  assert.equal(model.modelName, 'magic_link_token');
  const { definition, options, indexes } = model.schema;

  assert.equal(options.timestamps, true);
  assert.ok(definition.tokenHash.index, 'tokenHash must be indexed for the verify lookup');
  assert.ok(definition.email.index);
  assert.deepEqual(definition.purpose.enum, ['login', 'invite']);
  assert.equal(definition.purpose.default, 'login');
  assert.equal(definition.expiresAt.required, true);
  assert.equal(definition.usedAt.default, null);
  assert.equal(definition.meta.type, 'MIXED');
  // No plaintext token field exists at all.
  assert.equal('token' in definition, false);

  // TTL janitor index on expiresAt.
  assert.deepEqual(indexes, [
    { fields: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ]);
});

test('getMagicLinkTokenModel: reuses an already-registered model (hot reload safe)', () => {
  const mongoose = stubMongoose();
  const first = getMagicLinkTokenModel(mongoose);
  const second = getMagicLinkTokenModel(mongoose);
  assert.equal(first, second);
});
