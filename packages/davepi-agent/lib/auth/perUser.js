'use strict';

const crypto = require('node:crypto');
const { UnlinkedError } = require('../errors');

/**
 * Per-user auth strategy. Each (channel, channel_user_id) maps to a
 * davepi user via a refresh token stored locally. Access tokens are
 * minted on demand and cached until they're within
 * `refreshSkewSeconds` of expiry.
 *
 * Linking flow (revised after PR #128 review):
 *
 *   davepi does NOT have a browser-redirect OAuth-style /login; it
 *   only exposes POST /login with a JSON body and POST /auth/refresh
 *   with { refreshToken }. So the agent hosts the link UI itself:
 *
 *     1. First contact from an unlinked user → throws UnlinkedError
 *        with linkUrl = <agent>/link/<one-time-nonce>.
 *     2. The user opens that page; agent serves a small HTML form
 *        (email + password).
 *     3. Form POSTs credentials to <agent>/link/<nonce>; agent calls
 *        davepi's POST /login server-to-server, receives the refresh
 *        token in the JSON response, stores it against the
 *        (channel, channel_user_id) that the nonce was issued for.
 *     4. The user's refresh token never crosses the browser query
 *        string or referer header.
 *
 * Token refresh uses POST /auth/refresh with body { refreshToken }
 * (the actual davepi route — the earlier draft hit /refresh, which
 * doesn't exist).
 */

function createPerUserAuth({
  davepiUrl,
  store,
  refreshSkewSeconds = 60,
  linkBaseUrl = null,
  fetchImpl = globalThis.fetch,
  nonceTtlSeconds = 15 * 60,
} = {}) {
  if (!davepiUrl) throw new Error('per-user auth requires davepiUrl');
  if (!store) throw new Error('per-user auth requires a store');
  if (!fetchImpl) throw new Error('per-user auth requires fetch (Node >= 18)');

  const pendingNonces = new Map(); // nonce → { channel, channelUserId, createdAt }

  async function exchangeRefresh(refreshToken) {
    const url = new URL('/auth/refresh', davepiUrl).toString();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
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

  async function loginAndGetRefreshToken({ email, password }) {
    const url = new URL('/login', davepiUrl).toString();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`davepi login failed: ${res.status} ${text}`);
      err.status = res.status;
      err.code = 'LOGIN_FAILED';
      throw err;
    }
    const body = await res.json();
    const refreshToken = body.refreshToken || body.refresh_token;
    const davepiUserId = body.user?._id || body.user?.user_id || null;
    if (!refreshToken) {
      const err = new Error('davepi /login response missing refreshToken');
      err.code = 'LOGIN_FAILED';
      throw err;
    }
    return { refreshToken, accessToken: body.token, davepiUserId };
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
      : now + 14 * 60 * 1000;
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
    pruneExpiredNonces();
    const nonce = crypto.randomBytes(16).toString('hex');
    pendingNonces.set(nonce, { channel, channelUserId, createdAt: Date.now() });
    const url = new URL(`/link/${nonce}`, linkBaseUrl).toString();
    return { url, nonce };
  }

  function pruneExpiredNonces() {
    const cutoff = Date.now() - nonceTtlSeconds * 1000;
    for (const [n, v] of pendingNonces) {
      if (v.createdAt < cutoff) pendingNonces.delete(n);
    }
  }

  function lookupNonce(nonce) {
    pruneExpiredNonces();
    return pendingNonces.get(nonce) || null;
  }

  async function completeLinkWithCredentials({ nonce, email, password }) {
    const pending = lookupNonce(nonce);
    if (!pending) {
      const err = new Error('Unknown or expired link nonce');
      err.code = 'BAD_NONCE';
      throw err;
    }
    const { refreshToken, accessToken, davepiUserId } = await loginAndGetRefreshToken({ email, password });
    pendingNonces.delete(nonce);
    const expiresAt = accessToken ? Date.now() + 14 * 60 * 1000 : null;
    await store.upsert({
      channel: pending.channel,
      channel_user_id: pending.channelUserId,
      refresh_token: refreshToken,
      access_token: accessToken || null,
      access_expires_at: expiresAt,
      davepi_user_id: davepiUserId,
    });
    return { channel: pending.channel, channelUserId: pending.channelUserId, davepiUserId };
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
        throw new UnlinkedError(link.url);
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
    startLink,
    lookupNonce,
    completeLinkWithCredentials,
    async unlink(channelCtx) {
      await store.delete(channelCtx.channel, channelCtx.channelUserId);
    },
    async close() {
      if (store.close) await store.close();
    },
    _exchangeRefresh: exchangeRefresh,
    _loginAndGetRefreshToken: loginAndGetRefreshToken,
  };
}

module.exports = { createPerUserAuth };
