'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServiceAuth } = require('../lib/auth/service');

test('service auth requires bearer or clientId', () => {
  assert.throws(() => createServiceAuth({}), /DAVEPI_BEARER or DAVEPI_CLIENT_ID/);
});

test('service auth prefers bearer over clientId when both set', async () => {
  const auth = createServiceAuth({ bearer: 'jwt-value', clientId: 'ignored' });
  const h = await auth.headersFor({});
  assert.equal(h.authorization, 'Bearer jwt-value');
  assert.equal(h['x-client-id'], undefined);
});

test('service auth uses X-Client-Id when bearer is absent', async () => {
  const auth = createServiceAuth({ clientId: 'public-client' });
  const h = await auth.headersFor({});
  assert.equal(h['x-client-id'], 'public-client');
  assert.equal(h.authorization, undefined);
});

test('service auth returns identical headers across calls', async () => {
  const auth = createServiceAuth({ bearer: 'stable' });
  const a = await auth.headersFor({ channel: 'http', channelUserId: 'one' });
  const b = await auth.headersFor({ channel: 'slack', channelUserId: 'two' });
  assert.deepEqual(a, b);
});

test('service auth always reports linked', async () => {
  const auth = createServiceAuth({ bearer: 'x' });
  assert.equal(await auth.isLinked({}), true);
  assert.equal(await auth.linkUrl({}), null);
});
