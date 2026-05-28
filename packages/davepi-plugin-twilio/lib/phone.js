'use strict';

/**
 * Phone-number normalisation. Wraps `libphonenumber-js` lazily so the
 * package's own unit tests can run without the dep installed in the
 * sandbox. Callers that need to short-circuit the dep in tests can
 * pass an injected `parsePhoneNumberFromString` override.
 */

let cachedLib = null;
function loadLib() {
  if (cachedLib) return cachedLib;
  try {
    cachedLib = require('libphonenumber-js');
  } catch (err) {
    cachedLib = null;
  }
  return cachedLib;
}

/**
 * Normalise a phone string to E.164. Returns `null` for malformed
 * input so callers can map that to a typed ValidationError without
 * libphonenumber-js leaking into the error message.
 *
 * `defaultCountry` is an optional ISO 3166-1 alpha-2 code used when
 * the input is missing the leading `+` / country code. Defaults to
 * `undefined`, in which case any input without a `+` is rejected
 * (safer for a multi-country SaaS than silently assuming `US`).
 */
function normalisePhone(input, opts = {}) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const overrideParse = opts.parsePhoneNumberFromString;
  const parse = overrideParse || (loadLib() && loadLib().parsePhoneNumberFromString);
  if (!parse) {
    // Fallback when libphonenumber-js isn't available: accept any
    // string that's already E.164-ish (+ followed by 8-15 digits).
    // Production setups always have the dep; this branch keeps the
    // dev-side experience usable in a sandbox without it.
    return /^\+[1-9]\d{7,14}$/.test(input.trim()) ? input.trim() : null;
  }
  try {
    const parsed = parse(input, opts.defaultCountry);
    if (!parsed || !parsed.isValid()) return null;
    return parsed.number; // E.164
  } catch (err) {
    return null;
  }
}

module.exports = { normalisePhone };
