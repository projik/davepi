require("dotenv").config();
require("./config/database").connect();

const app = require("./app");
const logger = require("./utils/logger");

const { API_PORT } = process.env;
const port = Number(process.env.PORT || API_PORT);

// Wait for boot to finish before binding the port. The schema loader's
// initial pass (REST routers, GraphQL schema, Apollo middleware) runs
// inside an async IIFE that resolves `app.locals.ready`. Without this
// await, clients can race the startup and receive 404s for /api/*
// while the per-schema routers are still being attached.
(async () => {
  if (app.locals && app.locals.ready) {
    try {
      await app.locals.ready;
    } catch (err) {
      logger.fatal({ err }, 'app failed to become ready; exiting');
      process.exit(1);
    }
  }
  app.listen(port, () => {
    logger.info({ port }, 'listening');
  });
})();
