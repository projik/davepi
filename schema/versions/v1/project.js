module.exports = {
  path: 'project',
  collection: 'project',
  label: 'Project',
  pluralLabel: 'Projects',
  displayField: 'name',
  fields: [
    { name: 'accountId', type: String, required: true, stamped: true },
    { name: 'userId', type: String, required: true, stamped: true },
    { name: 'name', type: String, required: true, searchable: true },
    { name: 'description', type: String },
    { name: 'products', type: [String] },
    { name: 'parent', type: String, reference: 'project' },
  ],
  relations: {
    parentProject: { belongsTo: 'project', localKey: 'parent' },
  },
};
