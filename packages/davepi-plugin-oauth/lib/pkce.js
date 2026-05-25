'use strict';

/**
 * PKCE (RFC 7636) helpers.
 *
 * `code_verifier` is a high-entropy random string the client keeps;
 * `code_challenge` is its SHA-256 hash, base64url-encoded. The
 * verifier travels to the token endpoint at callback time. Even with
 * a confidential client (client secret on the server), PKCE
 * eliminates a class of authorization-code-interception attacks, so
 * the framework turns it on for every provider that supports it.
 *
 * GitHub at the time of writing does NOT support PKCE — its token
 * endpoint accepts but ignores `code_verifier`. The adapter still
 * generates and sends one; the provider just ignores it. Safer than
 * a per-provider conditional in the dance code.
 */

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateVerifier(bytes = 32) {
  // RFC 7636: verifier is 43..128 chars, [A-Z a-z 0-9 - . _ ~]. 32
  // bytes base64url-encoded is 43 chars and well within the cap.
  return b64url(crypto.randomBytes(bytes));
}

function challengeFor(verifier) {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

function generatePair() {
  const verifier = generateVerifier();
  return { verifier, challenge: challengeFor(verifier), method: 'S256' };
}

module.exports = { generateVerifier, challengeFor, generatePair };
