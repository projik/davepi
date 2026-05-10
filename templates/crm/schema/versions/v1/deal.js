module.exports = {
  path: 'deal',
  collection: 'deal',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'parentAccountId', type: String, required: true },
    { name: 'title', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'amount', type: Number, required: true },
    { name: 'currency', type: String, default: 'USD' },
    { name: 'expectedCloseAt', type: Date },
    { name: 'closedAt', type: Date },
    {
      // The classic CRM funnel as a state machine. The framework
      // rejects undeclared transitions and surfaces the available
      // next states on every read so the admin SPA renders the
      // right action buttons automatically.
      name: 'stage',
      type: String,
      stateMachine: {
        initial: 'lead',
        states: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
        transitions: {
          lead: ['qualified', 'lost'],
          qualified: ['proposal', 'lost'],
          proposal: ['negotiation', 'won', 'lost'],
          negotiation: ['won', 'lost'],
          won: [],
          lost: ['lead'],
        },
      },
    },
  ],
  relations: {
    account: { belongsTo: 'account', localKey: 'parentAccountId' },
    activities: { hasMany: 'activity', foreignKey: 'dealId' },
  },
  aggregations: [
    {
      name: 'pipelineByStage',
      description: 'Total amount and count grouped by deal stage.',
      pipeline: [
        { $group: { _id: '$stage', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ],
      cache: { ttlSeconds: 30 },
    },
    {
      name: 'wonByMonth',
      description: 'Sum of won-deal amounts grouped by close month.',
      // `closedAt` is optional, so $year/$month would throw on rows
      // where the field is null or missing. The $type filter keeps
      // only documents whose closedAt is actually a Date — anything
      // else (null, missing, accidental string) is excluded before
      // it reaches the date operators.
      pipeline: [
        { $match: { stage: 'won', closedAt: { $type: 'date' } } },
        {
          $group: {
            _id: {
              year: { $year: '$closedAt' },
              month: { $month: '$closedAt' },
            },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ],
      cache: { ttlSeconds: 60 },
    },
  ],
};
