module.exports = {
  path: 'account',
  collection: 'account',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true, searchWeight: 5 },
    { name: 'industry', type: String },
    { name: 'website', type: String },
    { name: 'description', type: String, searchable: true },
    { name: 'employees', type: Number },
    { name: 'logo', type: 'File', file: { maxBytes: 2 * 1024 * 1024, accept: ['image/*'], access: 'public' } },
  ],
  relations: {
    contacts: { hasMany: 'contact', foreignKey: 'parentAccountId' },
    deals: { hasMany: 'deal', foreignKey: 'parentAccountId' },
    primaryContact: {
      hasOne: 'contact',
      foreignKey: 'parentAccountId',
      where: { isPrimary: true },
    },
  },
};
