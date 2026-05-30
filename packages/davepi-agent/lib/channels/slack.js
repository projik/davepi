'use strict';

const logger = require('../logger');
const { runTurn } = require('../orchestrator');

/**
 * Slack channel using @slack/bolt. Two surfaces:
 *
 *   - app_mention in a channel → reply in thread
 *   - direct message to the bot → reply in DM
 *
 * Per-user mode maps Slack user id → channel_user_id. If the user
 * is not yet linked, the agent will throw UNLINKED inside
 * runTurn and we surface the link URL in chat. After the user
 * clicks the link and finishes davepi /login, they're back.
 *
 * Render events are translated:
 *   render_table → Block Kit (markdown table inside a mrkdwn
 *                  section, plus a divider). For wide tables (>10
 *                  columns) we fall back to a fenced code block.
 *   render_chart → QuickChart URL embedded as an image block.
 *
 * Per-conversation history is kept in-memory keyed by thread_ts;
 * this is intentionally not persisted — restart resets history.
 * Operators who need persistence can wire a store later.
 */

const QUICKCHART_URL = 'https://quickchart.io/chart';

const conversationHistory = new Map(); // threadKey → history[]

function threadKey(event) {
  return `${event.channel}::${event.thread_ts || event.ts}`;
}

function tableToBlocks(payload) {
  const cols = payload.columns;
  const rows = payload.rows || [];
  const wide = cols.length > 10;
  const header = cols.map((c) => c.label).join(' | ');
  const sep = cols.map(() => '---').join(' | ');
  const body = rows
    .map((r) => cols.map((c) => formatCell(r[c.key])).join(' | '))
    .join('\n');
  const text = wide
    ? '```\n' + [header, sep, body].join('\n') + '\n```'
    : [`*${payload.title || 'Results'}*`, '```', header, sep, body, '```'].join('\n');
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
  ];
}

function formatCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '…' : v;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v);
}

function chartToBlocks(payload) {
  const spec = encodeURIComponent(JSON.stringify(payload.vegaLiteSpec));
  const url = `${QUICKCHART_URL}?c=${spec}&v=5`;
  return [
    ...(payload.title
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `*${payload.title}*` } }]
      : []),
    { type: 'image', image_url: url, alt_text: payload.title || 'chart' },
  ];
}

/**
 * Translate one `render` event payload into Block Kit blocks, reusing the
 * same table/chart rendering the interactive handler uses. Unknown render
 * types yield no blocks. Shared so the proactive (cron) poster renders
 * identically to a reply in a thread.
 */
function renderEventToBlocks(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.type === 'table') return tableToBlocks(payload);
  if (payload.type === 'chart') return chartToBlocks(payload);
  return [];
}

/**
 * Compose the final message blocks for an agent turn: the reply text as a
 * mrkdwn section (when non-empty) followed by any render blocks. Returns
 * `undefined` when there's nothing to render, so callers can fall back to
 * a plain-text post.
 */
function buildResultBlocks({ text, renderBlocks = [] } = {}) {
  const blocks = [];
  if (text) blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  blocks.push(...renderBlocks);
  return blocks.length ? blocks : undefined;
}

/**
 * A minimal Slack poster built on the same `@slack/bolt`-bundled
 * `@slack/web-api` client the interactive channel uses. The proactive
 * (cron) surface has no inbound event to reply to, so it posts to a
 * configured channel directly rather than going through the bolt event
 * loop — but it reuses this package's block rendering so a scheduled
 * digest looks like any other agent reply.
 */
function createSlackPoster({ botToken } = {}) {
  if (!botToken) {
    throw new Error('createSlackPoster requires a Slack bot token (config.slack.botToken).');
  }
  const { WebClient } = require('@slack/web-api');
  const client = new WebClient(botToken);
  return {
    client,
    async post({ channel, text, renderBlocks = [], threadTs } = {}) {
      if (!channel) throw new Error('slack poster: a target channel is required');
      const blocks = buildResultBlocks({ text, renderBlocks });
      return client.chat.postMessage({
        channel,
        thread_ts: threadTs || undefined,
        text: text || ' ',
        blocks,
      });
    },
  };
}

async function handleMessage({ app, event, client, config, model, mcpClient, auth }) {
  const slackUserId = event.user;
  const text = (event.text || '').replace(/<@[^>]+>/g, '').trim();
  if (!text) return;

  const key = threadKey(event);
  const channelCtx = {
    channel: 'slack',
    channelUserId: slackUserId,
    // Conversation scope is the thread, not the user: keeps each
    // thread/DM a separate persisted transcript so context can't leak
    // across them. (Mirrors the in-memory `key` used below.)
    conversationId: key,
  };
  const history = conversationHistory.get(key) || [];

  let assembledText = '';
  const renderBlocks = [];
  let placeholderTs = null;

  try {
    const placeholder = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: '…',
    });
    placeholderTs = placeholder.ts;

    const onEvent = (evt) => {
      if (evt.type === 'token') {
        assembledText += evt.text;
      } else if (evt.type === 'render') {
        const payload = evt.payload;
        if (payload.type === 'table') renderBlocks.push(...tableToBlocks(payload));
        else if (payload.type === 'chart') renderBlocks.push(...chartToBlocks(payload));
      }
    };

    const out = await runTurn({
      config,
      model,
      mcpClient,
      channelCtx,
      history,
      userMessage: text,
      onEvent,
    });

    conversationHistory.set(key, out.history);

    await client.chat.update({
      channel: event.channel,
      ts: placeholderTs,
      text: out.text || ' ',
      blocks: buildResultBlocks({ text: out.text, renderBlocks }),
    });
  } catch (err) {
    logger.error({ err: err.message, code: err.code }, 'slack handler failed');
    const msg =
      err.code === 'UNLINKED' && err.linkUrl
        ? `Please link your account first: ${err.linkUrl}`
        : `Sorry, I hit an error: ${err.message}`;
    if (placeholderTs) {
      await client.chat.update({ channel: event.channel, ts: placeholderTs, text: msg }).catch(() => {});
    } else {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: msg,
      }).catch(() => {});
    }
  }
}

async function startSlackChannel({ config, model, mcpClient, auth }) {
  if (!config.slack.botToken || !config.slack.signingSecret) {
    throw new Error(
      'Slack channel enabled but SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET are missing.'
    );
  }
  const { App } = require('@slack/bolt');
  const app = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    socketMode: config.slack.socketMode,
    appToken: config.slack.appToken || undefined,
  });

  app.event('app_mention', async ({ event, client }) => {
    await handleMessage({ app, event, client, config, model, mcpClient, auth });
  });

  app.message(async ({ event, client }) => {
    if (event.channel_type !== 'im' || event.subtype) return;
    await handleMessage({ app, event, client, config, model, mcpClient, auth });
  });

  if (!config.slack.socketMode) {
    await app.start(config.slack.port);
    logger.info({ port: config.slack.port }, 'davepi-agent slack channel listening (http)');
  } else {
    await app.start();
    logger.info('davepi-agent slack channel listening (socket mode)');
  }
  return app;
}

module.exports = {
  startSlackChannel,
  tableToBlocks,
  chartToBlocks,
  renderEventToBlocks,
  buildResultBlocks,
  createSlackPoster,
};
