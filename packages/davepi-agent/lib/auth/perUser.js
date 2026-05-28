'use strict';

const crypto = require('node:crypto');

/**
 * Per-user auth strategy. Each (channel, channel_user_id) maps to a
 * davepi user via stored refresh token. Access tokens are minted on
 * demand and cached until they're within `refreshSkewSeconds` of
 * expiry. First contact from an unlinked user returns a link URL
 * that points at davepi's /login with a redirect back to the agent's
 * /oauth/callback.
 *
 * Refresh exchange uses davepi's POST /refresh (model/refreshToken.js
 * + utils/tokens.js on the server side). The agent never sees the
 * refresh token after storage — calls just pass it back through the
 * exchange endpoint.
 */

function createPerUserAuth({
  davepiUrl,
  store,
  refreshSkewSeconds = 60,
  linkBaseUrl = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!davepiUrl) throw new Error('per-user auth requires davepiUrl');
  if (!store) throw new Error('per-user auth requires a store');
  if (!fetchImpl) throw new Error('per-user auth requires fetch (Node >= 18)');

  const pendingNonces = new Map(); // nonce → { channel, channel_user_id, createdAt }

  async function exchangeRefresh(refreshToken) {
    const url = new URL('/refresh', davepiUrl).toString();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: refreshToken, refreshToken }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`davepi refresh failed: ${res.status} ${text}`);
      err.status = res.status;
      err.code = res.status === 401 ? 'UNLINKED' : 'REFRESH_FAILED';
      throw err;
    }
    const body = await res.json();
    return {
      accessToken: body.token || body.accessToken,
      refreshToken: body.refreshToken || refreshToken,
      expiresIn: body.expiresIn || body.expires_in || null,
    };
  }

  async function getFreshAccessToken(row) {
    const now = Date.now();
    const skewMs = refreshSkewSeconds * 1000;
    if (row.access_token && row.access_expires_at && row.access_expires_at - now > skewMs) {
      return row.access_token;
    }
    const exchanged = await exchangeRefresh(row.refresh_token);
    const expiresAt = exchanged.expiresIn
      ? now + exchanged.expiresIn * 1000
      : now + 14 * 60 * 1000; // assume 15m TTL, refresh 1m early
    await store.upsert({
      channel: row.channel,
      channel_user_id: row.channel_user_id,
      refresh_token: exchanged.refreshToken,
      access_token: exchanged.accessToken,
      access_expires_at: expiresAt,
    });
    return exchanged.accessToken;
  }

  function startLink({ channel, channelUserId }) {
    if (!linkBaseUrl) {
      throw new Error('AGENT_LINK_BASE_URL must be set to support per-user linking');
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    pendingNonces.set(nonce, { channel, channelUserId, createdAt: Date.now() });
    const redirect = new URL('/oauth/callback', linkBaseUrl);
    redirect.searchParams.set('nonce', nonce);
    const login = new URL('/login', davepiUrl);
    login.searchParams.set('redirect_uri', redirect.toString());
    return { url: login.toString(), nonce };
  }

  async function completeLink({ nonce, refreshToken, davepiUserId }) {
    const pending = pendingNonces.get(nonce);
    if (!pending) {
      const err = new Error('Unknown or expired link nonce');
      err.code = 'BAD_NONCE';
      throw err;
    }
    pendingNonces.delete(nonce);
    await store.upsert({
      channel: pending.channel,
      channel_user_id: pending.channelUserId,
      refresh_token: refreshToken,
      access_token: null,
      access_expires_at: null,
      davepi_user_id: davepiUserId || null,
    });
    return pending;
  }

  return {
    mode: 'per-user',
    async headersFor(channelCtx = {}) {
      const { channel, channelUserId } = channelCtx;
      if (!channel || !channelUserId) {
        throw new Error(
          'per-user auth requires channel + channelUserId in channelCtx for every request'
        );
      }
      const row = await store.get(channel, channelUserId);
      if (!row || !row.refresh_token) {
        const link = startLink({ channel, channelUserId });
        const err = new Error('User is not linked to davepi yet');
        err.code = 'UNLINKED';
        err.linkUrl = link.url;
        throw err;
      }
      const accessToken = await getFreshAccessToken(row);
      return { authorization: `Bearer ${accessToken}` };
    },
    async isLinked(channelCtx) {
      const row = await store.get(channelCtx.channel, channelCtx.channelUserId);
      return !!(row && row.refresh_token);
    },
    async linkUrl(channelCtx) {
      return startLink({
        channel: channelCtx.channel,
        channelUserId: channelCtx.channelUserId,
      }).url;
    },
    completeLink,
    async unlink(channelCtx) {
      await store.delete(channelCtx.channel, channelCtx.channelUserId);
    },
    async close() {
      if (store.close) await store.close();
    },
    _exchangeRefresh: exchangeRefresh,
  };
}

module.exports = { createPerUserAuth };
