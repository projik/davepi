module.exports = {
  path: 'invite',
  collection: 'invite',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'orgId', type: String, required: true },
    { name: 'email', type: String, required: true },
    { name: 'role', type: String, default: 'member' },
    {
      name: 'status',
      type: String,
      stateMachine: {
        initial: 'pending',
        states: ['pending', 'accepted', 'declined', 'revoked', 'expired'],
        transitions: {
          pending: ['accepted', 'declined', 'revoked', 'expired'],
          accepted: [],
          declined: [],
          revoked: [],
          expired: ['pending'],
        },
      },
    },
    { name: 'expiresAt', type: Date },
    { name: 'acceptedAt', type: Date },
  ],
  relations: {
    org: { belongsTo: 'org', localKey: 'orgId' },
  },
};
