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
      // The `internal` flag itself is hidden from callers without
      // staff/admin roles via field-level ACL. NB: this hides the
      // FLAG, not the comment body — field-level ACL only strips
      // the named field. To make staff-only notes truly private to
      // customers, model them as a separate resource so list/get
      // queries never return them, or apply a list-time filter in
      // a custom route. See the README walkthrough.
      acl: { read: ['staff', 'admin'] },
    },
    { name: 'authorName', type: String },
  ],
  relations: {
    ticket: { belongsTo: 'ticket', localKey: 'ticketId' },
  },
};
