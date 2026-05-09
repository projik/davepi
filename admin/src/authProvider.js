import { apiFetch, getToken, setToken } from './api.js';

/**
 * Refine auth provider backed by davepi's `/login` and `/register`.
 *
 * The access token is stored in localStorage; logout clears it.
 * Refine calls `check` on every protected route — we treat the
 * presence of any token as authenticated. The API itself is the
 * authority on validity (a stale token will get 401 and the
 * dataProvider's apiFetch surfaces it).
 */
export function createAuthProvider() {
  return {
    async login({ email, password }) {
      try {
        const body = await apiFetch('/login', {
          method: 'POST',
          body: { email, password },
        });
        if (body && body.accessToken) {
          setToken(body.accessToken);
          return { success: true, redirectTo: '/' };
        }
        return {
          success: false,
          error: { name: 'LoginFailed', message: 'Invalid response from server' },
        };
      } catch (err) {
        return {
          success: false,
          error: { name: 'LoginFailed', message: err.message || 'Login failed' },
        };
      }
    },

    async logout() {
      setToken(null);
      return { success: true, redirectTo: '/login' };
    },

    async check() {
      return getToken()
        ? { authenticated: true }
        : { authenticated: false, redirectTo: '/login' };
    },

    async onError(error) {
      if (error && error.status === 401) {
        return { logout: true, redirectTo: '/login' };
      }
      return {};
    },

    async getIdentity() {
      const token = getToken();
      if (!token) return null;
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return {
          id: payload.user_id,
          email: payload.email,
          roles: payload.roles || [],
        };
      } catch (_) {
        return null;
      }
    },
  };
}
