const dns = require('dns').promises;
const net = require('net');

/**
 * SSRF-defensive URL validation for outbound user-controlled targets.
 *
 * Rejects:
 *   - non-http(s) schemes
 *   - the literal hostnames `localhost` and `0.0.0.0`
 *   - direct IP literals in private / loopback / link-local / unique-
 *     local ranges (IPv4 and IPv6)
 *   - hostnames whose DNS lookup resolves to any of the above. This
 *     blocks `attacker.com → 127.0.0.1` as well as direct IPs.
 *
 * `allowPrivate: true` short-circuits all of the above (used by tests
 * that bind a receiver on 127.0.0.1; production callers must NEVER
 * pass this).
 */

const isLoopbackV4 = (ip) => ip.startsWith('127.');
const isLinkLocalV4 = (ip) => ip.startsWith('169.254.');
const isPrivateV4 = (ip) => {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  // 172.16.0.0/12 = 172.16.0.0 .. 172.31.255.255
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] || '0', 10);
    return second >= 16 && second <= 31;
  }
  return false;
};
const isLoopbackV6 = (ip) => ip === '::1';
const isLinkLocalV6 = (ip) => ip.toLowerCase().startsWith('fe80:');
const isUniqueLocalV6 = (ip) => {
  const lc = ip.toLowerCase();
  return lc.startsWith('fc') || lc.startsWith('fd');
};

const isPrivateAddress = (ip) => {
  const family = net.isIP(ip);
  if (family === 4) {
    return isLoopbackV4(ip) || isLinkLocalV4(ip) || isPrivateV4(ip);
  }
  if (family === 6) {
    return isLoopbackV6(ip) || isLinkLocalV6(ip) || isUniqueLocalV6(ip);
  }
  return false;
};

const PROTECTED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '']);

async function validateWebhookUrl(rawUrl, { allowPrivate = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error('url must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must use http or https');
  }
  if (allowPrivate) return parsed;

  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');

  if (PROTECTED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new Error('url hostname not allowed');
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error('url targets a private address');
    }
    return parsed;
  }

  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (_) {
    throw new Error('url hostname did not resolve');
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error('url resolves to a private address');
    }
  }
  return parsed;
}

module.exports = { validateWebhookUrl, isPrivateAddress };
