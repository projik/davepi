/**
 * Tiny TTL cache for aggregation results. Keyed on
 * `${resource}:${name}:${userId}:${JSON.stringify(params)}` so two
 * users querying the same aggregation don't share rows, and so the
 * same user's two distinct param sets get separate entries.
 *
 * The cache is per-process and bounded by `maxEntries` to avoid
 * unbounded memory growth in long-running deployments. Eviction is
 * approximate-LRU via a Map's insertion-order semantics.
 */
function createAggregationCache({ maxEntries = 200 } = {}) {
  const store = new Map();

  function key({ resource, name, userId, params }) {
    return `${resource}:${name}:${String(userId)}:${JSON.stringify(params || {})}`;
  }

  function get(k) {
    const entry = store.get(k);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      store.delete(k);
      return undefined;
    }
    // Refresh insertion order so recently-read entries survive eviction.
    store.delete(k);
    store.set(k, entry);
    return entry.value;
  }

  function set(k, value, ttlSeconds) {
    if (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey !== undefined) store.delete(oldestKey);
    }
    store.set(k, {
      value,
      expiresAt: Date.now() + Math.max(1, Number(ttlSeconds) || 0) * 1000,
    });
  }

  function clear() {
    store.clear();
  }

  return { key, get, set, clear, size: () => store.size };
}

module.exports = { createAggregationCache };
