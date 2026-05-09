require("dotenv").config();
require("./config/database").connect();

const app = require("./app");
const logger = require("./utils/logger");

const { API_PORT } = process.env;
const port = process.env.PORT || API_PORT;

app.listen(port, () => {
  logger.info({ port }, 'server listening');
});
