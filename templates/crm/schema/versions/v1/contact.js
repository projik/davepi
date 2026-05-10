module.exports = {
  path: 'contact',
  collection: 'contact',
  fields: [
    { name: 'userId', type: String, required: true },
    // NB: not `accountId` — the framework auto-stamps `accountId` on
    // every record from the JWT user_id (legacy quirk), so a manual
    // foreign key needs a different name. parentAccountId is what we
    // use to point at the parent account.
    { name: 'parentAccountId', type: String, required: true },
    { name: 'firstName', type: String, required: true, searchable: true },
    { name: 'lastName', type: String, required: true, searchable: true, searchWeight: 3 },
    {
      name: 'fullName',
      type: String,
      computed: (r) => [r.firstName, r.lastName].filter(Boolean).join(' '),
      description: 'First and last name joined.',
    },
    { name: 'email', type: String, searchable: true },
    { name: 'phone', type: String },
    { name: 'role', type: String },
    { name: 'isPrimary', type: Boolean, default: false },
  ],
  relations: {
    account: { belongsTo: 'account', localKey: 'parentAccountId' },
    activities: { hasMany: 'activity', foreignKey: 'contactId' },
  },
};
