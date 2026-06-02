module.exports = {
  path: 'contact',
  collection: 'contact',
  label: 'Contact',
  pluralLabel: 'Contacts',
  displayField: 'fullName',
  fields: [
    { name: 'userId', type: String, required: true, stamped: true },
    // NB: not `accountId` — the framework auto-stamps `accountId` on
    // every record from the JWT user_id (legacy quirk), so a manual
    // foreign key needs a different name. parentAccountId is what we
    // use to point at the parent account. `reference: 'account'` lets
    // the admin UI render a RelationPicker against the account list
    // instead of an opaque UUID input.
    { name: 'parentAccountId', type: String, required: true, reference: 'account', label: 'Account' },
    { name: 'firstName', type: String, required: true, searchable: true, label: 'First name' },
    { name: 'lastName', type: String, required: true, searchable: true, searchWeight: 3, label: 'Last name' },
    {
      name: 'fullName',
      type: String,
      computed: (r) => [r.firstName, r.lastName].filter(Boolean).join(' '),
      description: 'First and last name joined.',
      label: 'Full name',
    },
    { name: 'email', type: String, searchable: true, widget: 'email' },
    { name: 'phone', type: String },
    { name: 'role', type: String },
    { name: 'isPrimary', type: Boolean, default: false, label: 'Primary contact' },
  ],
  relations: {
    account: { belongsTo: 'account', localKey: 'parentAccountId' },
    activities: { hasMany: 'activity', foreignKey: 'contactId' },
  },
};
