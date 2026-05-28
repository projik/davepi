'use strict';

/**
 * Outbound SMS / WhatsApp via the Twilio SDK. The plugin owns config
 * (env + state) and passes a configured Twilio client + state in.
 * Both helpers are intentionally thin wrappers around
 * `client.messages.create` so the underlying Twilio surface (status
 * callbacks, validity periods, scheduled sends, etc.) remains usable
 * via pass-through options.
 */

function ensureWhatsAppPrefix(addr) {
  if (typeof addr !== 'string' || !addr) return addr;
  return addr.startsWith('whatsapp:') ? addr : `whatsapp:${addr}`;
}

async function sendSms(client, state, { to, body, messagingServiceSid, statusCallback, ...rest } = {}) {
  if (!to || !body) {
    throw new Error('davepi-plugin-twilio: sendSms requires { to, body }');
  }
  const params = { to, body, ...rest };
  // Caller override > env messaging service SID > env from-number.
  const msid = messagingServiceSid || state.messagingServiceSid;
  if (msid) {
    params.messagingServiceSid = msid;
  } else if (state.fromNumber) {
    params.from = state.fromNumber;
  } else {
    throw new Error(
      'davepi-plugin-twilio: sendSms needs TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER'
    );
  }
  if (statusCallback) params.statusCallback = statusCallback;
  return client.messages.create(params);
}

async function sendWhatsApp(client, state, { to, templateSid, variables, body, ...rest } = {}) {
  if (!to) {
    throw new Error('davepi-plugin-twilio: sendWhatsApp requires { to }');
  }
  if (!state.whatsappFrom) {
    throw new Error('davepi-plugin-twilio: TWILIO_WHATSAPP_FROM is not set');
  }
  const params = {
    to: ensureWhatsAppPrefix(to),
    from: state.whatsappFrom,
    ...rest,
  };
  if (templateSid) {
    params.contentSid = templateSid;
    if (variables !== undefined) {
      // Twilio requires contentVariables to be a JSON string keyed by
      // the template's placeholder index ("1", "2", ...).
      params.contentVariables = typeof variables === 'string'
        ? variables
        : JSON.stringify(variables || {});
    }
  } else {
    if (!body) {
      throw new Error('davepi-plugin-twilio: sendWhatsApp requires templateSid or body');
    }
    params.body = body;
  }
  return client.messages.create(params);
}

module.exports = { sendSms, sendWhatsApp, ensureWhatsAppPrefix };
