'use strict';

/**
 * Unit tests for persistDraftSkill — tenant stamping, the draft-status
 * contract, and idempotency (both the cheap findOne short-circuit and
 * the E11000 race that slips past it).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { persistDraftSkill } = require('../lib/persist');

const skill = { name: 'Reset a locked account', description: 'unlock', body: 'steps' };

// findOne returns a query with `.lean()`, matching Mongoose; create can
// be made to throw a duplicate-key error to simulate a lost race.
function makeModel({ existing = null, createThrows = null } = {}) {
  const rows = [];
  return {
    rows,
    findOne() {
      return { lean: async () => existing };
    },
    async create(doc) {
      if (createThrows) throw createThrows;
      const row = { _id: `id-${rows.length + 1}`, ...doc };
      rows.push(row);
      return row;
    },
  };
}

test('creates a draft scoped to the originating tenant', async () => {
  const model = makeModel();
  const res = await persistDraftSkill({
    model,
    tenant: { userId: 'acct-A', accountId: 'acct-A' },
    agentKey: 'support',
    skill,
  });
  assert.equal(res.created, true);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].status, 'draft');
  assert.equal(model.rows[0].userId, 'acct-A');
  assert.equal(model.rows[0].accountId, 'acct-A');
  assert.equal(model.rows[0].useCount, 0);
});

test('accountId defaults to the tenant userId when absent', async () => {
  const model = makeModel();
  await persistDraftSkill({ model, tenant: { userId: 'acct-A' }, agentKey: 'support', skill });
  assert.equal(model.rows[0].accountId, 'acct-A');
});

test('skips when a skill with the same name already exists (findOne)', async () => {
  const model = makeModel({ existing: { _id: 'existing-1', status: 'approved' } });
  const res = await persistDraftSkill({
    model,
    tenant: { userId: 'acct-A' },
    agentKey: 'support',
    skill,
  });
  assert.equal(res.created, false);
  assert.equal(res.reason, 'exists');
  assert.equal(res.existingId, 'existing-1');
  assert.equal(model.rows.length, 0);
});

test('treats an E11000 race on create as a benign skip, not a failure', async () => {
  const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  const model = makeModel({ createThrows: dup });
  const res = await persistDraftSkill({
    model,
    tenant: { userId: 'acct-A' },
    agentKey: 'support',
    skill,
  });
  assert.equal(res.created, false);
  assert.equal(res.reason, 'exists');
});

test('non-duplicate create errors propagate (so the queue can retry)', async () => {
  const boom = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const model = makeModel({ createThrows: boom });
  await assert.rejects(
    () =>
      persistDraftSkill({ model, tenant: { userId: 'acct-A' }, agentKey: 'support', skill }),
    /connection reset/
  );
});

test('refuses to persist without a model or a tenant userId', async () => {
  const noModel = await persistDraftSkill({ model: null, tenant: { userId: 'a' }, agentKey: 's', skill });
  assert.equal(noModel.reason, 'no-model');
  const noTenant = await persistDraftSkill({ model: makeModel(), tenant: {}, agentKey: 's', skill });
  assert.equal(noTenant.reason, 'no-tenant');
});
