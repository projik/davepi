'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Pluggable key-value store for per-user auth state. Default is a
 * SQLite file (one row per (channel, channel_user_id) → refresh
 * token plus cached access token + expiry). Swap by setting
 * STORE_URL to a different scheme; for now only `sqlite:` and
 * `memory:` are wired.
 *
 * Rows look like:
 *   { channel, channel_user_id, refresh_token, access_token,
 *     access_expires_at, davepi_user_id, created_at, updated_at }
 *
 * Access tokens are cached so we don't burn a refresh round-trip on
 * every tool call; we still re-mint when the cached one is within
 * `refreshSkewSeconds` of expiry.
 */

function memoryStore() {
  const rows = new Map();
  const key = (channel, userId) => `${channel}::${userId}`;
  return {
    async get(channel, userId) {
      return rows.get(key(channel, userId)) || null;
    },
    async upsert(row) {
      const k = key(row.channel, row.channel_user_id);
      const now = Date.now();
      const prev = rows.get(k);
      rows.set(k, { created_at: prev?.created_at || now, ...prev, ...row, updated_at: now });
      return rows.get(k);
    },
    async delete(channel, userId) {
      rows.delete(key(channel, userId));
    },
    async close() {},
  };
}

function sqliteStore(filepath) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    const e = new Error(
      'STORE_URL is sqlite: but better-sqlite3 is not installed. ' +
        'Either `npm install better-sqlite3` or set STORE_URL=memory: for ephemeral state.'
    );
    e.cause = err;
    throw e;
  }
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const db = new Database(filepath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_user_links (
      channel TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      refresh_token TEXT,
      access_token TEXT,
      access_expires_at INTEGER,
      davepi_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (channel, channel_user_id)
    );
  `);
  const get = db.prepare(
    'SELECT * FROM agent_user_links WHERE channel = ? AND channel_user_id = ?'
  );
  const upsert = db.prepare(`
    INSERT INTO agent_user_links
      (channel, channel_user_id, refresh_token, access_token, access_expires_at, davepi_user_id, created_at, updated_at)
    VALUES (@channel, @channel_user_id, @refresh_token, @access_token, @access_expires_at, @davepi_user_id, @created_at, @updated_at)
    ON CONFLICT (channel, channel_user_id) DO UPDATE SET
      refresh_token = COALESCE(excluded.refresh_token, agent_user_links.refresh_token),
      access_token = excluded.access_token,
      access_expires_at = excluded.access_expires_at,
      davepi_user_id = COALESCE(excluded.davepi_user_id, agent_user_links.davepi_user_id),
      updated_at = excluded.updated_at
  `);
  const del = db.prepare(
    'DELETE FROM agent_user_links WHERE channel = ? AND channel_user_id = ?'
  );
  return {
    async get(channel, userId) {
      return get.get(channel, userId) || null;
    },
    async upsert(row) {
      const now = Date.now();
      const existing = get.get(row.channel, row.channel_user_id) || null;
      upsert.run({
        channel: row.channel,
        channel_user_id: row.channel_user_id,
        refresh_token: row.refresh_token ?? null,
        access_token: row.access_token ?? null,
        access_expires_at: row.access_expires_at ?? null,
        davepi_user_id: row.davepi_user_id ?? null,
        created_at: existing?.created_at || now,
        updated_at: now,
      });
      return get.get(row.channel, row.channel_user_id);
    },
    async delete(channel, userId) {
      del.run(channel, userId);
    },
    async close() {
      db.close();
    },
  };
}

function openStore(url) {
  if (!url || url === 'memory:' || url === 'memory:/') return memoryStore();
  if (url.startsWith('sqlite:')) return sqliteStore(url.slice('sqlite:'.length));
  throw new Error(`Unsupported STORE_URL scheme: ${url}`);
}

module.exports = { openStore, memoryStore };
