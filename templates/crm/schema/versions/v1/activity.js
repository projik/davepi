module.exports = {
  path: 'activity',
  collection: 'activity',
  label: 'Activity',
  pluralLabel: 'Activities',
  displayField: 'subject',
  fields: [
    { name: 'userId', type: String, required: true, stamped: true },
    {
      name: 'type',
      type: String,
      required: true,
      enum: ['call', 'email', 'meeting', 'note'],
    },
    { name: 'subject', type: String, required: true, searchable: true },
    { name: 'body', type: String, searchable: true, widget: 'textarea' },
    { name: 'occurredAt', type: Date, default: Date.now, label: 'Occurred at' },
    // Optional pointers into the parent record. An activity is
    // typically attached to either a contact OR a deal — both are
    // optional so a free-form note is also valid.
    { name: 'contactId', type: String, reference: 'contact', label: 'Contact' },
    { name: 'dealId', type: String, reference: 'deal', label: 'Deal' },
  ],
  relations: {
    contact: { belongsTo: 'contact', localKey: 'contactId' },
    deal: { belongsTo: 'deal', localKey: 'dealId' },
  },
};
