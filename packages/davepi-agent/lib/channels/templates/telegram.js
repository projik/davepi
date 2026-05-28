'use strict';

/**
 * Telegram adapter — STUB.
 *
 * Fill this in by wiring node-telegram-bot-api (or grammy) against
 * a `TELEGRAM_BOT_TOKEN`. The shape mirrors lib/channels/slack.js:
 *   1. on message → derive channelCtx = { channel: 'telegram',
 *      channelUserId: msg.from.id }
 *   2. call runTurn(...) from ../../orchestrator
 *   3. translate render events to Telegram primitives:
 *        render_table → sendMessage with monospace formatted text,
 *                       or sendDocument with CSV for wide tables
 *        render_chart → sendPhoto with a QuickChart URL
 *   4. maintain per-chat history keyed by chat.id
 *
 * The auth strategy works exactly as for Slack — per-user mode
 * issues a link URL on first contact and the user clicks through
 * to /login on the davepi server.
 */

async function startTelegramChannel(/* { config, model, mcpClient, auth } */) {
  throw new Error('Telegram channel is not implemented yet. See lib/channels/templates/telegram.js.');
}

module.exports = { startTelegramChannel };
