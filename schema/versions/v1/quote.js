module.exports = {
  path: 'quote',
  collection: 'quote',
  label: 'Quote',
  pluralLabel: 'Quotes',
  displayField: 'description',
  fields: [
    { name: 'accountId', type: String, required: true, stamped: true },
    { name: 'userId', type: String, required: true, stamped: true },
    {
      name: 'contactId',
      type: String,
      required: true,
      reference: 'contact',
      label: 'Contact',
    },
    { name: 'description', type: String, searchable: true },
    { name: 'products', type: [String] },
  ],
  // contactId is a real parent FK against the contact collection (not
  // a tenant marker). Declaring belongsTo lets `buildManifest()`
  // auto-populate the inverse `quotes` hasMany on contact so the admin
  // UI can render a "Quotes" tab on each contact's detail page.
  relations: {
    contact: { belongsTo: 'contact', localKey: 'contactId' },
  },
  // Declarative aggregation endpoints. Each entry produces:
  //   GET /api/v1/quote/aggregations/<name>  (REST)
  //   query <path><PascalCaseName>(...)      (GraphQL)
  // The framework prepends $match: { userId } before the pipeline,
  // so callers only ever see their own rows.
  aggregations: [
    {
      name: 'countByAccount',
      description:
        'Quote count grouped by accountId for the authenticated user.',
      pipeline: [
        { $group: { _id: '$accountId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ],
      cache: { ttlSeconds: 30 },
    },
  ],
};
