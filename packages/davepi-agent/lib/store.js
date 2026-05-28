'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

/**
 * Pluggable async key-value store for per-user auth state. Two
 * backends ship in v1:
 *
 *   memory:   in-process Map. Ephemeral. Used by tests.
 *   file:     atomic JSON file. Default. One row per
 *             (channel, channel_user_id) → refresh token plus
 *             cached access token + expiry. Async via fs.promises.
 *
 * The earlier draft used better-sqlite3, which is synchronous and
 * blocks the event loop inside `async` methods. For the per-user
 * surface (one row per channel user, low write rate, all-fits-in-
 * memory) a JSON file is simpler and stays async-clean. Operators
 * with high write rates can swap in a real DB by writing another
 * backend behind the same interface.
 *
 * Rows: {
 *   channel, channel_user_id, refresh_token, access_token,
 *   access_expires_at, davepi_user_id, created_at, updated_at
 * }
 *
 * Writes are atomic: write to a `<path>.tmp` then rename — POSIX
 * guarantees the rename is observed as a single inode swap, so a
 * crash mid-write can't leave a half-written file.
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

function fileStore(filepath) {
  const abs = path.isAbsolute(filepath) ? filepath : path.resolve(process.cwd(), filepath);
  fsSync.mkdirSync(path.dirname(abs), { recursive: true });

  // Serialise reads + writes through a single promise chain so two
  // concurrent upserts can't race past each other and lose a row.
  // The whole file is small (one row per linked user), so reading
  // and writing the lot per mutation is fine.
  let chain = Promise.resolve();
  const queue = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  const k = (channel, userId) => `${channel}::${userId}`;

  async function readAll() {
    try {
      const text = await fs.readFile(abs, 'utf8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
  }

  async function writeAll(data) {
    const tmp = `${abs}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, abs);
  }

  return {
    async get(channel, userId) {
      return queue(async () => {
        const data = await readAll();
        return data[k(channel, userId)] || null;
      });
    },
    async upsert(row) {
      return queue(async () => {
        const data = await readAll();
        const id = k(row.channel, row.channel_user_id);
        const now = Date.now();
        const prev = data[id];
        data[id] = { created_at: prev?.created_at || now, ...prev, ...row, updated_at: now };
        await writeAll(data);
        return data[id];
      });
    },
    async delete(channel, userId) {
      return queue(async () => {
        const data = await readAll();
        delete data[k(channel, userId)];
        await writeAll(data);
      });
    },
    async close() {
      await chain;
    },
  };
}

function openStore(url) {
  if (!url || url === 'memory:' || url === 'memory:/') return memoryStore();
  if (url.startsWith('file:')) return fileStore(url.slice('file:'.length));
  // Backwards-compat: previously documented `sqlite:` URLs now route
  // to the file backend. Same path, no native dep.
  if (url.startsWith('sqlite:')) {
    const filepath = url.slice('sqlite:'.length).replace(/\.sqlite$/, '.json');
    return fileStore(filepath);
  }
  throw new Error(`Unsupported STORE_URL scheme: ${url}. Use memory: or file:<path>.`);
}

module.exports = { openStore, memoryStore, fileStore };
