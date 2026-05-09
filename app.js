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

const { API_PORT } = process.env;
const port = process.env.PORT || API_PORT;
const appName = process.env.APP_NAME || "dAvePi";

require('mongoose-schema-jsonschema')(mongoose);

const isProduction = () => process.env.NODE_ENV === 'production';

// Default helmet (CSP enabled) for all routes. Swagger UI and Apollo's
// GraphQL Playground need inline scripts / remote bundles, so CSP and
// crossOriginEmbedderPolicy are dropped only for those paths.
const helmetDefault = helmet();
const helmetForBrowserTooling = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api-docs') || req.path.startsWith('/graphql')) {
    return helmetForBrowserTooling(req, res, next);
  }
  return helmetDefault(req, res, next);
});
app.use(buildCorsMiddleware());
app.use(express.json());
app.use(httpLogger);
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
  if (!token) return { user: null };
  try {
    const decoded = jwt.verify(token, process.env.TOKEN_KEY);
    return { user: decoded };
  } catch (err) {
    return { user: null };
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
const filteredTree = dirTree("./schema/versions", { extensions: /\.js/ });
const initialSchemas = [];
filteredTree.children.forEach((versionDir) => {
  versionDir.children.forEach((file) => {
    const schemaModule = require("./" + file.path);
    schemaModule.version = versionDir.name;
    schemaModule.__sourceFile = path.resolve(file.path);
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
app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(apiSpec));

// Errors from any route — REST handlers, /auth/*, the indirection
// middleware that delegates to the current Apollo router — flow through
// this single handler. The Apollo router is mounted ABOVE this in the
// stack via the indirection above, so middleware-level errors inside it
// reach errorHandler too.
app.use(errorHandler);

module.exports = app;
