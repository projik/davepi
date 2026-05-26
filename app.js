// Importing this module is a pure operation: it builds the Express app,
// the Mongoose models, the GraphQL schema, and the Swagger spec, but
// does NOT load .env or connect to MongoDB. The caller (index.js or a
// test harness) is responsible for both. This makes app.js safe to
// require from tests with an in-memory Mongo URI already set.
const express = require("express");
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const swaggerUI = require("swagger-ui-express");
const app = express();
const dirTree = require("directory-tree");
const path = require("path");
const crypto = require("crypto");

const errorHandler = require("./middleware/errorHandler");
const httpLogger = require("./middleware/httpLogger");
const { metricsMiddleware, metricsHandler } = require("./middleware/metrics");
const { buildCorsMiddleware } = require("./middleware/corsConfig");
const { authLimiter, apiLimiter } = require("./middleware/rateLimit");
const asyncHandler = require("./utils/asyncHandler");
const logger = require("./utils/logger");
const {
  ValidationError,
  ConflictError,
} = require("./utils/errors");
const {
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
} = require("./utils/tokens");
const { sendMail } = require("./utils/mailer");
const PasswordResetToken = require("./model/passwordResetToken");
const RefreshToken = require("./model/refreshToken");
const { createSchemaLoader } = require("./utils/schemaLoader");
const { startSchemaWatcher } = require("./utils/schemaWatcher");
const { loadPlugins } = require("./utils/pluginLoader");
const { bus: eventBus } = require("./utils/events");

const { API_PORT } = process.env;
const port = process.env.PORT || API_PORT;
const appName = process.env.APP_NAME || "dAvePi";

require('mongoose-schema-jsonschema')(mongoose);

const isProduction = () => process.env.NODE_ENV === 'production';

// Trust the upstream reverse proxy when configured. Without this,
// req.ip / X-Forwarded-For is treated as untrusted and the rate
// limiters key on the proxy's connection IP — meaning one noisy
// client would limit everyone behind the same proxy. Set
// TRUST_PROXY=true in deployments where Caddy / nginx / a PaaS
// load balancer terminates TLS in front of the app (the prod
// Docker Compose stack at deploy/docker-compose.prod.yml sets it).
// Off by default so a direct-exposed dev server doesn't trust
// spoofed headers.
if (String(process.env.TRUST_PROXY || '').toLowerCase() === 'true') {
  app.set('trust proxy', 1);
}

// Default helmet (CSP enabled) for all routes. Swagger UI, Apollo's
// GraphQL Playground, and the admin SPA need inline scripts / styles
// that the default CSP would block, so CSP and
// crossOriginEmbedderPolicy are dropped only for those paths.
// (ant-design in particular renders inline styles for every dynamic
// component — the admin UI is unusable behind the default style-src.)
const helmetDefault = helmet();
const helmetForBrowserTooling = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api-docs') ||
    req.path.startsWith('/graphql') ||
    req.path.startsWith('/admin')
  ) {
    return helmetForBrowserTooling(req, res, next);
  }
  return helmetDefault(req, res, next);
});
app.use(buildCorsMiddleware());
app.use(express.json());
app.use(httpLogger);
app.use(metricsMiddleware);
app.use('/api', apiLimiter);

const apiSpec = {
  info: {
    title: appName,
    version: "1.0.0",
    description: `${appName} REST API documentation.`,
  },
  host: `localhost:${port}`,
  basePath: "/",
  swagger: "2.0",
  paths: {},
  definitions: {},
};

// Apollo's schema is fixed at construction. To allow hot-reloading the
// schema in dev (issue #10) we mount a stable indirection middleware
// here; the loader swaps `apolloRouter` whenever a schema is added,
// changed, or removed. In production this still happens once at boot
// and never again, so there's no runtime cost.
let apolloRouter = null;
app.use((req, res, next) => {
  if (apolloRouter) return apolloRouter(req, res, next);
  return next();
});

const buildGraphqlContext = ({ req }) => {
  const header = req.headers.authorization || '';
  const token = header.replace(/^bearer\s+/i, '').trim();
  // `req` is threaded through so resolver wrappers in
  // utils/scopeResolver.js can pull `{ ip, userAgent, reqId }` onto
  // record-bus events (parity with REST). Only the narrow metadata
  // shape leaves the wrapper via `buildReqMeta(req)` — the full req
  // never reaches a bus subscriber.
  if (!token) return { user: null, req };
  try {
    const decoded = jwt.verify(token, process.env.TOKEN_KEY);
    return { user: decoded, req };
  } catch (err) {
    return { user: null, req };
  }
};

const schemaLoader = createSchemaLoader({
  app,
  apiSpec,
  setApolloRouter: (router) => { apolloRouter = router; },
  buildGraphqlContext,
  isProduction,
  errorHandler,
});

// Discover and load every schema synchronously at boot. Each loadSchema
// call is awaited later via the rebuildGraphQL Promise; tests and prod
// callers wait on the exported `app.locals.ready` Promise before issuing
// requests against /graphql/.
//
// `dirTree` walks "./schema/versions" relative to process.cwd() — i.e.
// the consumer's project root. The `require` call below MUST resolve
// the schema file against the same root, otherwise Node looks for it
// next to app.js (inside node_modules/davepi/ when installed as a dep)
// and crashes with MODULE_NOT_FOUND.
const filteredTree = dirTree("./schema/versions", { extensions: /\.js/ });
const initialSchemas = [];
filteredTree.children.forEach((versionDir) => {
  versionDir.children.forEach((file) => {
    const absPath = path.resolve(file.path);
    const schemaModule = require(absPath);
    schemaModule.version = versionDir.name;
    schemaModule.__sourceFile = absPath;
    initialSchemas.push(schemaModule);
  });
});

app.locals.ready = (async () => {
  for (const s of initialSchemas) {
    await schemaLoader.loadSchema(s, { deferGraphqlRebuild: true });
  }
  await schemaLoader.rebuildGraphQL();
  logger.info(
    { schemas: schemaLoader.listSchemas() },
    'schemas loaded'
  );

  // Plugins run AFTER schemas so they can introspect the registry
  // (e.g. wire a route per resource). Plugin specifiers come from
  // the consumer project's package.json under the `davepi.plugins`
  // key — see utils/pluginLoader.js for the contract. After loading,
  // re-assert the errorHandler tail so plugin-mounted routes route
  // their errors through the same shape every other handler uses.
  app.locals.plugins = await loadPlugins({
    app,
    schemaLoader,
    bus: eventBus,
    appName,
  });
  if (app.locals.plugins.length) {
    schemaLoader.moveErrorHandlerToEnd();
  }

  app.locals.schemaWatcher = startSchemaWatcher({ loader: schemaLoader });
})();

// expose for tests
app.locals.schemaLoader = schemaLoader;

const User = require("./model/user");

const buildUserResponse = (user) => {
  const obj = JSON.parse(JSON.stringify(user));
  delete obj.password;
  delete obj.__v;
  delete obj.token; // legacy field on the user model — never serialize it
  return obj;
};

app.post("/register", authLimiter, asyncHandler(async (req, res) => {
  const { first_name, last_name, email, password } = req.body;

  if (!(email && password && first_name && last_name)) {
    throw new ValidationError("All input is required");
  }

  const oldUser = await User.findOne({ email: email.toLowerCase() });
  if (oldUser) {
    throw new ConflictError("User Already Exists. Please Login");
  }

  const encryptedPassword = await bcrypt.hash(password, 10);

  const user = await User.create({
    first_name,
    last_name,
    email: email.toLowerCase(),
    password: encryptedPassword,
  });

  const tokens = await issueTokenPair(user, req);
  res.status(201).json({ ...tokens, user: buildUserResponse(user) });
}));

app.post("/login", authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!(email && password)) {
    throw new ValidationError("All input is required");
  }

  const user = await User.findOne(
    { email: email.toLowerCase() },
    { first_name: 1, last_name: 1, email: 1, password: 1, roles: 1 }
  );

  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new ValidationError("Invalid Credentials");
  }

  const tokens = await issueTokenPair(user, req);
  res.status(200).json({ ...tokens, user: buildUserResponse(user) });
}));

// Public on purpose: /auth/refresh is the path clients take when their
// access-token JWT has already expired, so requiring auth(true) here
// would make the endpoint useless. The refresh token in the body is the
// authentication — rotateRefreshToken hashes and looks it up against
// refresh_tokens, throws UnauthorizedError on miss/expired/reuse.
app.post("/auth/refresh", authLimiter, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    throw new ValidationError("refreshToken required");
  }
  const tokens = await rotateRefreshToken(refreshToken, req);
  res.status(200).json(tokens);
}));

// Public on purpose: a user whose access token has expired must still
// be able to log out (revoke their refresh token). The refresh token
// in the body identifies the session being terminated.
app.post("/auth/logout", asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  await revokeRefreshToken(refreshToken);
  res.status(204).end();
}));

const sha256 = (input) =>
  crypto.createHash("sha256").update(input).digest("hex");

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Public on purpose: this endpoint is the entry point to the recovery
// flow before the user has any credentials. Crucially it ALWAYS returns
// 204 — including when the email is unknown OR when token creation /
// email delivery fails internally — so it can't be used as a
// user-enumeration oracle. Internal errors are logged for operators.
app.post(
  "/auth/forgot-password",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (typeof email === "string" && email.length) {
      try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (user) {
          const rawToken = crypto.randomBytes(32).toString("hex");
          await PasswordResetToken.create({
            userId: user._id,
            tokenHash: sha256(rawToken),
            expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
          });
          const appUrl = process.env.APP_URL || "http://localhost:3000";
          const resetUrl = `${appUrl}/reset?token=${rawToken}`;
          await sendMail({
            to: user.email,
            subject: "Reset your password",
            text:
              `Someone requested a password reset for your account.\n\n` +
              `If this was you, follow this link within the next hour:\n\n` +
              `${resetUrl}\n\n` +
              `If not, ignore this email — your password is unchanged.`,
          });
        }
      } catch (err) {
        // Swallow on purpose. A DB or SMTP failure for a valid email must
        // not turn into a different HTTP response than the unknown-email
        // case — that's the enumeration oracle we're avoiding.
        (req.log || logger).error(
          { err },
          "forgot-password: internal failure (response still 204)"
        );
      }
    }
    res.status(204).end();
  })
);

// Public on purpose: the reset token in the body is the authentication.
// The token is single-use, hashed at rest, and expires after one hour.
app.post(
  "/auth/reset-password",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      throw new ValidationError("token and newPassword are required");
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      throw new ValidationError("Password must be at least 8 characters");
    }

    const record = await PasswordResetToken.findOneAndUpdate(
      {
        tokenHash: sha256(token),
        usedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { usedAt: new Date() } },
      { new: false }
    );
    if (!record) {
      throw new ValidationError("Invalid or expired reset token");
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ _id: record.userId }, { $set: { password: hashed } });

    // Revoke every active refresh token for the user — a password reset
    // means we're no longer sure who's holding the previous sessions.
    await RefreshToken.updateMany(
      { userId: record.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    res.status(204).end();
  })
);

// Webhook subscriptions for the user's records. The dispatcher itself
// is started below; the routes hand-fire test deliveries through it
// via app.locals.webhookDispatcher.
const webhookRouter = require('./routes/webhooks');
app.use(webhookRouter);

const { startWebhookDispatcher } = require('./utils/webhookDispatcher');
app.locals.webhookDispatcher = startWebhookDispatcher();

// Local file-storage serve route (HMAC-validated for private files).
// The s3 driver bypasses this; its presigned URLs point at S3 directly.
app.use(require('./routes/files'));

app.get('/api-docs/swagger.json', (req, res) => {
  res.status(200).json(apiSpec);
});
// swagger-ui-express snapshots the spec inside setup() — it embeds it
// in the page HTML once and serves that HTML on every request. Since
// schemas (and therefore `apiSpec.paths`) populate asynchronously via
// `app.locals.ready`, a plain `setup(apiSpec)` would lock the UI to the
// empty boot-time snapshot. Setting `req.swaggerDoc` per request makes
// the middleware re-render against the live spec, which also keeps the
// UI in sync after hot-reload mutations.
app.use(
  '/api-docs',
  (req, res, next) => { req.swaggerDoc = apiSpec; next(); },
  swaggerUI.serve,
  swaggerUI.setup(),
);

// Model Context Protocol endpoint. Per-request stateless transport:
// each call builds a fresh McpServer bound to the JWT user and a
// fresh StreamableHTTPServerTransport. The MCP SDK's transport
// converts JSON-RPC over POST into tool calls; we don't need session
// state because every tool resolves entirely from the schema
// registry + Mongo.
//
// Auth: standard Bearer token via the same auth(true) middleware as
// the rest of the API. The mcpServer's `getUser` callback returns
// req.user so every tool call sees the authenticated identity.
const { buildMcpServer } = require('./utils/mcpServer');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { MethodNotAllowedError } = require('./utils/errors');
const mcpAuth = require('./middleware/auth')(true);
app.post('/mcp', mcpAuth, asyncHandler(async (req, res) => {
  const server = buildMcpServer({
    schemaLoader,
    getUser: () => req.user,
    // Thread req through so MCP-driven CRUD events carry
    // `{ ip, userAgent, reqId }` on the record bus — parity with
    // REST and GraphQL.
    getReq: () => req,
    name: appName,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  // Best-effort early teardown if the client disconnects mid-request.
  // The deterministic cleanup in finally below covers the happy path
  // and keep-alive connections that don't fire 'close' immediately.
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}));
// MCP also uses GET for the SSE notification stream and DELETE for
// session termination — answer 405 in stateless mode rather than
// letting the request hang. Auth still applies (custom REST routes
// must protect their surface). Errors flow through the centralised
// errorHandler instead of inline res.status().json so the response
// shape stays consistent with the rest of the API.
const respondMethodNotAllowed = (msg) => (req, res, next) =>
  next(new MethodNotAllowedError(msg));
app.get('/mcp', mcpAuth, respondMethodNotAllowed(
  'GET /mcp is not supported in stateless mode; use POST.'
));
app.delete('/mcp', mcpAuth, respondMethodNotAllowed(
  'DELETE /mcp is not supported in stateless mode.'
));

// Compact, machine-readable capability manifest. Intentionally a flat
// projection of the live schema registry — agents land here first to
// learn the API surface (every resource's fields, relations,
// aggregations, file fields, ACL slots, soft-delete / audit / search
// flags) without ingesting the much larger swagger.json.
//
// Public by default. Set `DESCRIBE_REQUIRES_AUTH=true` to gate the
// endpoint behind a valid JWT — the manifest only exposes API
// surface, not data, so the default is permissive.
const { buildManifest } = require('./utils/describeManifest');
const describeAuthMiddleware = require('./middleware/auth')(true);
app.get('/_describe', (req, res, next) => {
  const requiresAuth =
    String(process.env.DESCRIBE_REQUIRES_AUTH || '').toLowerCase() === 'true';
  const respond = () =>
    res.status(200).json(buildManifest({ schemaLoader, appName }));
  if (!requiresAuth) return respond();
  describeAuthMiddleware(req, res, (err) => {
    if (err) return next(err);
    respond();
  });
});

// Prometheus metrics. Returns 404 when METRICS_ENABLED isn't 'true'
// so the endpoint behaves like it doesn't exist for projects that
// don't opt in. When enabled, optionally token-gated via METRICS_TOKEN.
app.get('/_metrics', asyncHandler(metricsHandler));

// Admin SPA — built artifacts live under admin/dist/. The catch-all
// handler is registered unconditionally so /admin/* requests don't
// fall through to Express's finalhandler (which injects
// `Content-Security-Policy: default-src 'none'` on 404 — breaking
// the helmet carve-out the admin SPA relies on). When the build is
// missing, the handler returns a clear 404 itself.
//
// Path is resolved against __dirname (the framework's own directory)
// rather than process.cwd() — when davepi is installed as a dep, the
// admin/dist/ bundle ships INSIDE node_modules/davepi/, not in the
// consumer's project root.
const adminDist = path.resolve(__dirname, 'admin/dist');
const hasAdminBuild = require('fs').existsSync(path.join(adminDist, 'index.html'));
if (hasAdminBuild) {
  app.use('/admin', express.static(adminDist));
}
app.get(/^\/admin(?:\/.*)?$/, (req, res) => {
  if (hasAdminBuild) {
    // SPA uses client-side routing under /admin/<resource>/...; the
    // wildcard falls back to index.html so a deep link survives a refresh.
    res.sendFile(path.join(adminDist, 'index.html'));
  } else {
    res.status(404).type('text/plain').send(
      'admin SPA bundle missing from this dAvePi install. ' +
      'Reinstall the `davepi` package, or — if developing on the framework itself — ' +
      'run `npm run build:admin` from the dAvePi repo root.'
    );
  }
});

// Errors from any route — REST handlers, /auth/*, the indirection
// middleware that delegates to the current Apollo router — flow through
// this single handler. The Apollo router is mounted ABOVE this in the
// stack via the indirection above, so middleware-level errors inside it
// reach errorHandler too.
app.use(errorHandler);

module.exports = app;
