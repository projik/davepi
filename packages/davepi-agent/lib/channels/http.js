'use strict';

const express = require('express');
const crypto = require('node:crypto');
const logger = require('../logger');
const { runTurn } = require('../orchestrator');
const asyncHandler = require('../asyncHandler');
const {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  UnlinkedError,
  NotFoundError,
  AppError,
} = require('../errors');

/**
 * HTTP channel.
 *
 * Surfaces:
 *
 *   GET  /health                liveness
 *   POST /chat                  SSE-streaming chat
 *   GET  /link/:nonce           HTML form (per-user mode only)
 *   POST /link/:nonce           form submission (per-user mode only)
 *   POST /oauth/callback        deprecated; refuses (refresh tokens
 *                                must not be passed in URLs / browser
 *                                redirects — the form-based link flow
 *                                above replaced it after PR #128 review)
 *
 * Trust boundaries:
 *
 *   - Service mode: every caller shares one identity; no per-caller
 *     auth needed on /chat. Anything CORS-allowed can talk.
 *
 *   - Per-user mode: /chat ignores any caller-supplied
 *     `channelUserId`. The agent issues a signed session cookie
 *     during /link/:nonce completion; /chat reads the cookie. A
 *     caller without a cookie gets 401 + a link URL. Cookies are
 *     HMAC-signed with AGENT_SESSION_SECRET (env or programmatic
 *     override). Without that secret, /chat refuses in per-user mode
 *     and the bin tells the operator to set it.
 *
 *   - The earlier draft trusted body.channelUserId, which let any
 *     caller act as any linked user — flagged in PR #128 review.
 *
 * Error shaping:
 *
 *   All routes are wrapped in asyncHandler and throw typed errors
 *   from ../errors. One terminal middleware maps every error to the
 *   { error: { code, message } } shape so handlers never write 4xx
 *   bodies inline.
 */

const SESSION_COOKIE = 'davepi_agent_session';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

function sseEvent(res, type, data) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function signSession(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
}

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function linkPageHtml({ nonce, error }) {
  const errBlock = error
    ? `<p class="err">${escapeHtml(error)}</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Link your davepi account</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 360px; margin: 4rem auto; padding: 0 1rem; }
  label { display: block; margin: 0.5rem 0 0.25rem; font-size: 0.9rem; }
  input { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
  button { margin-top: 1rem; padding: 0.6rem 1rem; font-size: 1rem; cursor: pointer; }
  .err { color: #c00; }
  .hint { color: #666; font-size: 0.85rem; }
</style>
</head><body>
<h1>Link your account</h1>
<p class="hint">Sign in to your davepi account. Your refresh token will be stored on the agent server; it never crosses your browser's URL or referer.</p>
${errBlock}
<form method="POST" action="/link/${encodeURIComponent(nonce)}" autocomplete="on">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required>
  <button type="submit">Link account</button>
</form>
</body></html>`;
}

function linkSuccessHtml() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Linked</title>
<style>body{font-family:system-ui,sans-serif;max-width:360px;margin:4rem auto;padding:0 1rem}</style>
</head><body>
<h1>Linked.</h1>
<p>You can close this tab and return to your chat.</p>
</body></html>`;
}

function ensureSessionSecret(config) {
  if (!config.http.sessionSecret) {
    throw new AppError(
      'AGENT_SESSION_SECRET must be set when using per-user auth with the HTTP channel.',
      500,
      'CONFIG_MISSING'
    );
  }
  return config.http.sessionSecret;
}

function channelUserIdFromCookie(req, secret) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = verifySession(secret, cookies[SESSION_COOKIE]);
  if (!session) return null;
  if (session.exp && session.exp < Math.floor(Date.now() / 1000)) return null;
  return session.cuid || null;
}

function createHttpApp({ config, model, mcpClient, auth }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  if (config.http.corsOrigins.length) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && config.http.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });
  }

  app.get('/health', (req, res) => {
    res.json({ ok: true, agent: 'davepi-agent', auth: auth.mode });
  });

  app.post('/chat', asyncHandler(async (req, res, next) => {
    const { message, history = [], stream = true } = req.body || {};
    if (!message || typeof message !== 'string') {
      throw new ValidationError('message (string) is required');
    }

    let channelUserId = null;
    if (auth.mode === 'per-user') {
      const secret = ensureSessionSecret(config);
      channelUserId = channelUserIdFromCookie(req, secret);
      if (!channelUserId) {
        const link = auth.startLink({ channel: 'http', channelUserId: crypto.randomBytes(8).toString('hex') });
        throw new UnlinkedError(link.url);
      }
    }

    // The HTTP channel has no thread concept: one ongoing conversation
    // per logged-in (cookie-identified) user. Service mode has no
    // channelUserId, so nothing is persisted (the client round-trips
    // history itself).
    const channelCtx = { channel: 'http', channelUserId, conversationId: channelUserId };
    const collectedEvents = [];
    let resHeadersWritten = false;
    let postFinalErrorSent = false;

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
      if (stream && resHeadersWritten) {
        // Headers are out — we have to surface the error on the SSE
        // stream rather than via the central error middleware. Strip
        // the message to a generic string so internals don't leak.
        sseEvent(res, 'error', {
          code: err.code || 'INTERNAL_ERROR',
          message: err instanceof AppError ? err.message : 'Internal error',
        });
        res.end();
        postFinalErrorSent = true;
        logger.error({ err: err.message, code: err.code }, 'POST /chat failed mid-stream');
        return;
      }
      throw err;
    }
    if (postFinalErrorSent) return;
  }));

  if (auth.mode === 'per-user') {
    app.get('/link/:nonce', asyncHandler(async (req, res) => {
      const { nonce } = req.params;
      const pending = auth.lookupNonce(nonce);
      if (!pending) throw new NotFoundError('link');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(linkPageHtml({ nonce }));
    }));

    app.post('/link/:nonce', asyncHandler(async (req, res) => {
      const { nonce } = req.params;
      const { email, password } = req.body || {};
      if (!email || !password) {
        res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(linkPageHtml({ nonce, error: 'Email and password are required.' }));
      }
      let result;
      try {
        result = await auth.completeLinkWithCredentials({ nonce, email, password });
      } catch (err) {
        if (err.code === 'BAD_NONCE') throw new NotFoundError('link');
        if (err.code === 'LOGIN_FAILED') {
          res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(linkPageHtml({ nonce, error: 'Invalid email or password.' }));
        }
        throw err;
      }
      // Issue a session cookie ONLY when the link was initiated from
      // the HTTP channel — other channels (Slack, Telegram) have their
      // own platform-signed identity and don't need a browser cookie.
      if (result.channel === 'http') {
        const secret = ensureSessionSecret(config);
        const now = Math.floor(Date.now() / 1000);
        const token = signSession(secret, {
          cuid: result.channelUserId,
          iat: now,
          exp: now + COOKIE_MAX_AGE_SECONDS,
        });
        const secure = config.http.cookieSecure ? '; Secure' : '';
        res.setHeader(
          'Set-Cookie',
          `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`
        );
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(linkSuccessHtml());
    }));

    app.post('/oauth/callback', (req, res, next) => {
      // Retained as an explicit refusal so legacy clients fail loudly
      // instead of silently. The original draft accepted refresh
      // tokens in this endpoint's query string, which leaked them via
      // logs / referer / browser history (PR #128 review #8).
      next(
        new ForbiddenError(
          'The /oauth/callback flow was removed; use GET /link/:nonce instead. Refresh tokens must not be passed in URLs.'
        )
      );
    });
  }

  // Centralised error handler — every async handler funnels here so
  // response shaping happens in exactly one place.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const code = err.code || 'INTERNAL_ERROR';
    const message =
      err instanceof AppError ? err.message : status >= 500 ? 'Internal error' : err.message || 'Error';
    if (status >= 500) {
      logger.error({ err: err.message, code, stack: err.stack }, 'http unhandled error');
    } else {
      logger.warn({ err: err.message, code, status }, 'http handler returned error');
    }
    if (res.headersSent) return;
    const body = { error: { code, message } };
    if (err instanceof UnlinkedError && err.linkUrl) body.error.linkUrl = err.linkUrl;
    res.status(status).json(body);
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

module.exports = {
  createHttpApp,
  startHttpServer,
  signSession,
  verifySession,
  parseCookieHeader,
};
