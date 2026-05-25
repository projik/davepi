'use strict';

/**
 * Normalize the caller's `sendEmail` / `sendTemplate` arguments into
 * the exact JSON shape Postmark's REST API expects. Pulled out of
 * index.js so the validation rules are easy to read and test in
 * isolation.
 *
 * Postmark accepts camelCase nowhere; every field is PascalCase. The
 * plugin's public surface is camelCase (idiomatic JS) and this module
 * is the only place the translation happens.
 *
 * Recipient fields (`to`, `cc`, `bcc`) accept either a single
 * address or an array. Postmark wants a comma-separated string, so
 * we join here.
 *
 * Throws `Error` (not a typed framework error) — these are
 * programmer-input mistakes, not user-facing validation failures, so
 * the framework's `errorHandler` shouldn't translate them.
 */

function joinAddresses(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const cleaned = value.map((s) => String(s).trim()).filter(Boolean);
    return cleaned.length ? cleaned.join(', ') : undefined;
  }
  const s = String(value).trim();
  return s || undefined;
}

function pickOptional(input, defaults = {}) {
  // Fields shared by /email and /email/withTemplate. Anything the
  // caller didn't set falls back to the plugin defaults (configured
  // at setup) and finally to "omit from the payload".
  const out = {};
  const from = input.from || defaults.from;
  if (from) out.From = String(from).trim();
  const to = joinAddresses(input.to);
  if (to) out.To = to;
  const cc = joinAddresses(input.cc);
  if (cc) out.Cc = cc;
  const bcc = joinAddresses(input.bcc);
  if (bcc) out.Bcc = bcc;
  const replyTo = input.replyTo || defaults.replyTo;
  if (replyTo) out.ReplyTo = String(replyTo).trim();
  if (input.tag)      out.Tag = String(input.tag);
  if (input.metadata && typeof input.metadata === 'object') out.Metadata = input.metadata;
  if (Array.isArray(input.headers)) out.Headers = input.headers;
  if (Array.isArray(input.attachments)) out.Attachments = input.attachments;
  if (input.trackOpens != null)  out.TrackOpens = !!input.trackOpens;
  if (input.trackLinks)          out.TrackLinks = String(input.trackLinks);
  const stream = input.messageStream || defaults.messageStream;
  if (stream) out.MessageStream = String(stream);
  return out;
}

function buildEmailPayload(input, defaults = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('davepi-plugin-postmark: sendEmail requires an options object');
  }
  const payload = pickOptional(input, defaults);
  if (!payload.From) {
    throw new Error('davepi-plugin-postmark: `from` is required (set POSTMARK_FROM or pass it in)');
  }
  if (!payload.To) {
    throw new Error('davepi-plugin-postmark: `to` is required');
  }
  if (!input.subject) {
    throw new Error('davepi-plugin-postmark: `subject` is required for sendEmail');
  }
  payload.Subject = String(input.subject);
  if (input.htmlBody) payload.HtmlBody = String(input.htmlBody);
  if (input.textBody) payload.TextBody = String(input.textBody);
  if (!payload.HtmlBody && !payload.TextBody) {
    throw new Error('davepi-plugin-postmark: one of `htmlBody` or `textBody` is required');
  }
  return payload;
}

function buildTemplatePayload(input, defaults = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('davepi-plugin-postmark: sendTemplate requires an options object');
  }
  const payload = pickOptional(input, defaults);
  if (!payload.From) {
    throw new Error('davepi-plugin-postmark: `from` is required (set POSTMARK_FROM or pass it in)');
  }
  if (!payload.To) {
    throw new Error('davepi-plugin-postmark: `to` is required');
  }
  // Postmark accepts either TemplateAlias or TemplateId — not both.
  // Alias is the idiomatic choice (stable name across environments)
  // but numeric IDs work too.
  if (input.templateAlias != null) {
    payload.TemplateAlias = String(input.templateAlias);
  } else if (input.templateId != null) {
    payload.TemplateId = Number(input.templateId);
    if (!Number.isFinite(payload.TemplateId)) {
      throw new Error('davepi-plugin-postmark: `templateId` must be a number');
    }
  } else {
    throw new Error('davepi-plugin-postmark: one of `templateAlias` or `templateId` is required');
  }
  if (input.templateModel != null) {
    if (typeof input.templateModel !== 'object') {
      throw new Error('davepi-plugin-postmark: `templateModel` must be an object');
    }
    payload.TemplateModel = input.templateModel;
  }
  if (input.inlineCss != null) payload.InlineCss = !!input.inlineCss;
  return payload;
}

module.exports = {
  joinAddresses,
  buildEmailPayload,
  buildTemplatePayload,
};
