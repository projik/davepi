const mongoose = require("mongoose");
const logger = require("../utils/logger");

const { MONGO_URI } = process.env;

exports.connect = () => {
  mongoose
    .connect(MONGO_URI, {})
    .then(() => {
      logger.info('connected to database');
    })
    .catch((err) => {
      logger.fatal({ err }, 'database connection failed; exiting');
      process.exit(1);
    });
};
