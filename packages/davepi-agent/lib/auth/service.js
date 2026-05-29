'use strict';

/**
 * Service-account auth strategy. One identity for the whole agent,
 * read once from config. Right for anonymous-storefront / single-role
 * customer-service deployments.
 *
 * Two headers are supported and they're mutually exclusive:
 *   - Authorization: Bearer <jwt>  (long-lived agent JWT)
 *   - X-Client-Id: <id>             (public read role, write refused server-side)
 *
 * Bearer wins if both are configured — that mirrors the davepi
 * server's own posture (see middleware/clientAuth.js).
 */

function createServiceAuth({ bearer, clientId } = {}) {
  if (!bearer && !clientId) {
    throw new Error(
      'service auth requires DAVEPI_BEARER or DAVEPI_CLIENT_ID. Set one in env or config.'
    );
  }
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  else headers['x-client-id'] = clientId;

  return {
    mode: 'service',
    async headersFor(/* channelCtx */) {
      return { ...headers };
    },
    async isLinked() {
      return true;
    },
    async linkUrl() {
      return null;
    },
    async close() {},
  };
}

module.exports = { createServiceAuth };
