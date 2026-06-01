module.exports = {
  path: 'category',
  collection: 'category',
  label: 'Category',
  pluralLabel: 'Categories',
  displayField: 'name',
  fields: [
    { name: 'accountId', type: String, required: true, stamped: true },
    { name: 'userId', type: String, required: true, stamped: true },
    { name: 'name', type: String, required: true, searchable: true },
    { name: 'description', type: String },
    { name: 'products', type: [String] },
    { name: 'parent', type: String, reference: 'category' },
  ],
  // Self-reference: a category can declare a parent category. The
  // admin UI's RelationPicker resolves `parent` against the category
  // list itself via `field.reference`.
  relations: {
    parentCategory: { belongsTo: 'category', localKey: 'parent' },
  },
};
