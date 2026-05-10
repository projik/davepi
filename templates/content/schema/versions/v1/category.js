module.exports = {
  path: 'category',
  collection: 'category',
  fields: [
    { name: 'userId', type: String, required: true },
    // Per-tenant unique (see compositeIndex below) — NOT globally
    // unique. Two different users can each have a "Engineering"
    // category without colliding.
    { name: 'name', type: String, required: true, searchable: true },
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
  // Tenant-scoped uniqueness on `name`. dAvePi scopes every read /
  // write by userId, so this index enforces "no duplicate name
  // within one user's categories" without blocking other users
  // from using the same string.
  compositeIndex: [{ userId: 1, name: 1 }],
  relations: {
    articles: { hasMany: 'article', foreignKey: 'categoryId' },
  },
};
