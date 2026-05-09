/**
 * Lightweight wrappers around fetch for talking to the davepi REST
 * API. Everything routes through here so the auth token lives in
 * exactly one place.
 *
 * Kept small on purpose — the admin UI doesn't need the full Refine
 * @refinedev/simple-rest because davepi's surface differs in three
 * specific ways:
 *
 *   - Pagination uses `__page` (1-based) instead of `_start`/`_end`.
 *   - Sort uses `__sort=field:asc|desc` instead of `_sort`/`_order`.
 *   - List response is `{ results, totalResults, page, ... }` instead
 *     of an array with a total in the header.
 *
 * The data provider in dataProvider.js translates Refine's calls into
 * these conventions.
 */

const TOKEN_KEY = 'davepi-admin-access-token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
};

const apiRoot = () => '';

export async function apiFetch(path, { method = 'GET', body, headers = {} } = {}) {
  const token = getToken();
  const res = await fetch(apiRoot() + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch (_) {}
    const err = new Error(payload?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = payload;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}
