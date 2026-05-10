module.exports = {
  path: 'ticket',
  collection: 'ticket',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'title', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'body', type: String, searchable: true },
    {
      name: 'priority',
      type: String,
      stateMachine: {
        // priority is also a state machine — escalation has rules.
        initial: 'normal',
        states: ['low', 'normal', 'high', 'urgent'],
        transitions: {
          low: ['normal'],
          normal: ['low', 'high'],
          high: ['normal', 'urgent'],
          urgent: ['high'],
        },
      },
    },
    {
      name: 'status',
      type: String,
      stateMachine: {
        initial: 'open',
        states: ['open', 'in_progress', 'resolved', 'closed', 'reopened'],
        transitions: {
          open: ['in_progress', 'closed'],
          in_progress: ['resolved', 'open'],
          resolved: ['closed', 'reopened'],
          closed: ['reopened'],
          reopened: ['in_progress', 'closed'],
        },
      },
    },
    { name: 'assigneeId', type: String },
    { name: 'reporterId', type: String, required: true },
    { name: 'resolvedAt', type: Date },
  ],
  relations: {
    comments: { hasMany: 'comment', foreignKey: 'ticketId' },
  },
  aggregations: [
    {
      name: 'byStatus',
      description: 'Ticket count grouped by current status.',
      pipeline: [
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ],
      cache: { ttlSeconds: 15 },
    },
    {
      name: 'urgentOpen',
      description: 'Open or in-progress urgent tickets, newest first.',
      pipeline: [
        { $match: { priority: 'urgent', status: { $in: ['open', 'in_progress'] } } },
        { $sort: { createdAt: -1 } },
      ],
      maxResults: 50,
    },
  ],
};
