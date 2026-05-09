  module.exports =  {
    path: 'quote',
    collection: 'quote',
    fields: [
      {
        name: 'accountId',
        type: String,
        required: true
      },
      {
        name: 'userId',
        type: String,
        required: true
      },
      {
        name: 'contactId',
        type: String,
        required: true
      },
      {
        name: 'description',
        type: String
      },
      {
        name: "products",
        type: [String]
      }
    ],
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
