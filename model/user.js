const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  first_name: { type: String, default: null, foo: 'bar' },
  last_name: { type: String, default: null },
  email: { type: String, unique: true },
  password: { type: String },
  token: { type: String },
  roles: { type: [String], default: ['user'] },
});

module.exports = mongoose.model("user", userSchema);