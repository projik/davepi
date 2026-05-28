const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  first_name: { type: String, default: null, foo: 'bar' },
  last_name: { type: String, default: null },
  email: { type: String, unique: true },
  password: { type: String },
  token: { type: String },
  roles: { type: [String], default: ['user'] },
  // Set by davepi-plugin-stripe when a user first hits /api/checkout
  // or /api/portal. Sparse so users without billing don't claim the
  // unique index slot; indexed because the webhook handler looks
  // users up by this field on every subscription event.
  stripeCustomerId: { type: String, default: null, index: true, sparse: true },
});

module.exports = mongoose.model("user", userSchema);