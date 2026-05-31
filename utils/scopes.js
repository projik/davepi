/**
 * Coarse scope check shared by the REST `requireScope` middleware and
 * the GraphQL scopeResolver wrappers, so both surfaces enforce API-key
 * scopes identically.
 *
 * API keys carry an explicit `scopes` array (`['read']`,
 * `['read', 'write']`). JWT sessions and X-Client-Id sessions do NOT
 * carry a `scopes` array — they implicitly hold every scope, so the
 * absence of the array means "unrestricted". This keeps behaviour
 * unchanged for everything that isn't an API key: only a request whose
 * `req.user.scopes` is a real array is ever constrained.
 */
const hasScope = (user, scope) => {
  if (!user) return false;
  if (!Array.isArray(user.scopes)) return true;
  return user.scopes.includes(scope);
};

module.exports = { hasScope };
