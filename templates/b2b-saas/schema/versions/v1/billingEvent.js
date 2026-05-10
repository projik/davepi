module.exports = {
  path: 'billingEvent',
  collection: 'billing_event',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'orgId', type: String, required: true },
    { name: 'kind', type: String, required: true }, // upgrade | downgrade | invoice | refund | usage
    { name: 'amount', type: Number },
    { name: 'currency', type: String, default: 'USD' },
    { name: 'externalRef', type: String }, // Stripe charge id, etc.
    { name: 'occurredAt', type: Date, default: Date.now },
  ],
  relations: {
    org: { belongsTo: 'org', localKey: 'orgId' },
  },
  aggregations: [
    {
      name: 'byOrg',
      description: 'Total billing amount per org for the authenticated tenant.',
      pipeline: [
        { $match: { amount: { $type: 'number' } } },
        { $group: { _id: '$orgId', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ],
      cache: { ttlSeconds: 60 },
    },
    {
      name: 'monthlyRecurring',
      description: 'Billing-event totals grouped by month.',
      pipeline: [
        { $match: { occurredAt: { $type: 'date' }, amount: { $type: 'number' } } },
        {
          $group: {
            _id: {
              year: { $year: '$occurredAt' },
              month: { $month: '$occurredAt' },
            },
            total: { $sum: '$amount' },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ],
      cache: { ttlSeconds: 60 },
    },
  ],
};
