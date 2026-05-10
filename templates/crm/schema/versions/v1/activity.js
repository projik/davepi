module.exports = {
  path: 'activity',
  collection: 'activity',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'type', type: String, required: true }, // call | email | meeting | note
    { name: 'subject', type: String, required: true, searchable: true },
    { name: 'body', type: String, searchable: true },
    { name: 'occurredAt', type: Date, default: Date.now },
    // Optional pointers into the parent record. An activity is
    // typically attached to either a contact OR a deal — both are
    // optional so a free-form note is also valid.
    { name: 'contactId', type: String },
    { name: 'dealId', type: String },
  ],
  relations: {
    contact: { belongsTo: 'contact', localKey: 'contactId' },
    deal: { belongsTo: 'deal', localKey: 'dealId' },
  },
};
