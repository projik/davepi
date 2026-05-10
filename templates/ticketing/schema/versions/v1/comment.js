module.exports = {
  path: 'comment',
  collection: 'comment',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'ticketId', type: String, required: true },
    { name: 'body', type: String, required: true, searchable: true },
    {
      name: 'internal',
      type: Boolean,
      default: false,
      // Internal-only comments are visible only to staff. Field-level
      // ACL strips them from the response for non-staff readers.
      acl: { read: ['user', 'staff', 'admin'] },
    },
    { name: 'authorName', type: String },
  ],
  relations: {
    ticket: { belongsTo: 'ticket', localKey: 'ticketId' },
  },
};
