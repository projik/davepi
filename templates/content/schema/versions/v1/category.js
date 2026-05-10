module.exports = {
  path: 'category',
  collection: 'category',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'name', type: String, required: true, searchable: true, unique: true },
    {
      name: 'slug',
      type: String,
      computed: (r) =>
        String(r.name || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
      description: 'URL-safe form of name, derived.',
    },
    { name: 'description', type: String, searchable: true },
  ],
  relations: {
    articles: { hasMany: 'article', foreignKey: 'categoryId' },
  },
};
