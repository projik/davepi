'use strict';

const { createServiceAuth } = require('./service');
const { createPerUserAuth } = require('./perUser');
const { openStore } = require('../store');

function createAuth(config) {
  const mode = config.auth?.mode || 'service';
  if (mode === 'service') {
    return createServiceAuth({
      bearer: config.auth.bearer,
      clientId: config.auth.clientId,
    });
  }
  if (mode === 'per-user') {
    const store = openStore(config.store?.url);
    return createPerUserAuth({
      davepiUrl: config.davepiUrl,
      store,
      refreshSkewSeconds: config.auth.refreshSkewSeconds,
      linkBaseUrl: config.auth.linkBaseUrl,
    });
  }
  throw new Error(`Unknown auth mode: ${mode}. Use 'service' or 'per-user'.`);
}

module.exports = { createAuth };
