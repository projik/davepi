module.exports = {
  path: 'workspace',
  collection: 'workspace',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'orgId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true },
    { name: 'description', type: String, searchable: true },
  ],
  relations: {
    org: { belongsTo: 'org', localKey: 'orgId' },
  },
};
