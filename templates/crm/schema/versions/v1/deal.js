module.exports = {
  path: 'deal',
  collection: 'deal',
  label: 'Deal',
  pluralLabel: 'Deals',
  displayField: 'title',
  fields: [
    { name: 'userId', type: String, required: true, stamped: true },
    { name: 'parentAccountId', type: String, required: true, reference: 'account', label: 'Account' },
    { name: 'title', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'amount', type: Number, required: true, widget: 'currency', format: 'currency:USD' },
    { name: 'currency', type: String, default: 'USD' },
    { name: 'expectedCloseAt', type: Date, label: 'Expected close' },
    { name: 'closedAt', type: Date, label: 'Closed' },
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
