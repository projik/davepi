'use strict';

const express = require('express');
const logger = require('../logger');
const { runTurn } = require('../orchestrator');

/**
 * HTTP channel: POST /chat with optional SSE streaming, GET /health
 * for liveness, and (per-user mode only) GET /oauth/callback to
 * complete a link flow.
 *
 * Request body:
 *   {
 *     message: string,
 *     history?: [{ role: 'user'|'assistant', content: string }],
 *     channelUserId?: string,   // required in per-user mode
 *     stream?: boolean          // default true
 *   }
 *
 * SSE event stream (one event per `data:` line, type = `event:`):
 *   token        { text }
 *   tool_call    { name, args }
 *   tool_result  { name, result }
 *   render       { payload: { type: 'table'|'chart', ... } }
 *   final        { text, history }
 *   error        { code?, message }
 *
 * Non-streaming mode returns one JSON envelope:
 *   { text, history, events: [...] }
 */

function sseEvent(res, type, data) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createHttpApp({ config, model, mcpClient, auth }) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  if (config.http.corsOrigins.length) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && config.http.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });
  }

  app.get('/health', (req, res) => {
    res.json({ ok: true, agent: 'davepi-agent', auth: auth.mode });
  });

  app.post('/chat', async (req, res, next) => {
    const { message, history = [], channelUserId, stream = true } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message (string) is required' });
    }
    const channelCtx = {
      channel: 'http',
      channelUserId: channelUserId || null,
    };

    const collectedEvents = [];
    let resHeadersWritten = false;

    const onEvent = (evt) => {
      collectedEvents.push(evt);
      if (stream && !resHeadersWritten) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        resHeadersWritten = true;
      }
      if (stream) sseEvent(res, evt.type, evt);
    };

    try {
      const out = await runTurn({
        config,
        model,
        mcpClient,
        channelCtx,
        history,
        userMessage: message,
        onEvent,
      });
      if (stream) {
        if (!resHeadersWritten) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.flushHeaders?.();
        }
        sseEvent(res, 'done', { ok: true });
        res.end();
      } else {
        res.json({ text: out.text, history: out.history, events: collectedEvents });
      }
    } catch (err) {
      logger.error({ err: err.message }, 'POST /chat failed');
      if (stream && resHeadersWritten) {
        sseEvent(res, 'error', { message: err.message, code: err.code || null });
        res.end();
      } else {
        next(err);
      }
    }
  });

  if (auth.mode === 'per-user') {
    app.get('/oauth/callback', async (req, res) => {
      const { nonce, refresh_token: refreshToken, davepi_user_id: davepiUserId } = req.query;
      if (!nonce || !refreshToken) {
        return res.status(400).send('Missing nonce or refresh_token in callback');
      }
      try {
        await auth.completeLink({ nonce, refreshToken, davepiUserId });
        res.send(
          '<html><body><h1>Linked.</h1><p>You can close this tab and return to your chat.</p></body></html>'
        );
      } catch (err) {
        res.status(400).send(`Link failed: ${err.message}`);
      }
    });
  }

  app.use((err, req, res, next) => {
    logger.error({ err: err.message, stack: err.stack }, 'http unhandled error');
    if (res.headersSent) return next(err);
    res.status(500).json({ error: { message: 'Internal error' } });
  });

  return app;
}

function startHttpServer({ config, model, mcpClient, auth }) {
  const app = createHttpApp({ config, model, mcpClient, auth });
  return new Promise((resolve) => {
    const server = app.listen(config.http.port, () => {
      logger.info(
        { port: config.http.port, auth: auth.mode },
        'davepi-agent http channel listening'
      );
      resolve({ app, server });
    });
  });
}

module.exports = { createHttpApp, startHttpServer };
