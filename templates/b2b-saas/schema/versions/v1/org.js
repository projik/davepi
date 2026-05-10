module.exports = {
  path: 'org',
  collection: 'org',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true, searchWeight: 5 },
    {
      name: 'slug',
      type: String,
      computed: (r) =>
        String(r.name || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
    },
    { name: 'plan', type: String, default: 'trial' }, // trial | starter | growth | enterprise
    { name: 'seats', type: Number, default: 5 },
  ],
  relations: {
    workspaces: { hasMany: 'workspace', foreignKey: 'orgId' },
    invites: { hasMany: 'invite', foreignKey: 'orgId' },
  },
};
