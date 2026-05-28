'use strict';

/**
 * WhatsApp adapter — STUB.
 *
 * Two viable transports:
 *   - Twilio WhatsApp Sandbox / WhatsApp Business API (preferred,
 *     because davepi-plugin-twilio already exists and you can
 *     borrow its credential conventions).
 *   - Meta's WhatsApp Cloud API directly.
 *
 * Shape mirrors lib/channels/slack.js:
 *   1. webhook in → derive channelCtx = { channel: 'whatsapp',
 *      channelUserId: from.phoneNumber }
 *   2. call runTurn(...) from ../../orchestrator
 *   3. translate render events:
 *        render_table → text message with monospace formatting,
 *                       or media message with a generated PNG for
 *                       wide tables
 *        render_chart → media message with a QuickChart PNG URL
 *   4. maintain per-conversation history keyed by phone number
 *
 * WhatsApp has stricter outbound rules (24-hour customer-care
 * window, template messages for proactive messages) — make sure
 * any production deployment respects those.
 */

async function startWhatsappChannel(/* { config, model, mcpClient, auth } */) {
  throw new Error('WhatsApp channel is not implemented yet. See lib/channels/templates/whatsapp.js.');
}

module.exports = { startWhatsappChannel };
