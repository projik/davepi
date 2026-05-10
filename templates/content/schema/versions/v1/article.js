module.exports = {
  path: 'article',
  collection: 'article',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'title', type: String, required: true, searchable: true, searchWeight: 5 },
    {
      name: 'slug',
      type: String,
      computed: (r) =>
        String(r.title || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
      description: 'URL-safe form of title, derived.',
    },
    { name: 'body', type: String, searchable: true },
    { name: 'excerpt', type: String },
    { name: 'categoryId', type: String },
    { name: 'tags', type: [String] },
    { name: 'authorName', type: String },
    { name: 'publishedAt', type: Date },
    {
      name: 'heroImage',
      type: 'File',
      file: {
        maxBytes: 5 * 1024 * 1024,
        accept: ['image/jpeg', 'image/png', 'image/webp'],
        access: 'public',
      },
    },
    {
      name: 'status',
      type: String,
      stateMachine: {
        initial: 'draft',
        states: ['draft', 'review', 'published', 'archived'],
        transitions: {
          draft: ['review', 'archived'],
          review: ['published', 'draft'],
          published: ['archived', 'draft'],
          archived: ['draft'],
        },
        // onEnter hooks run best-effort with `(record, { user, from,
        // to })`. They're side-effect channels — notifications,
        // webhooks, downstream events — not write-back. To stamp
        // `publishedAt` automatically, send it on the PUT that
        // transitions to `published` (the framework's audit log
        // captures the timestamp regardless).
      },
    },
  ],
  relations: {
    category: { belongsTo: 'category', localKey: 'categoryId' },
  },
  aggregations: [
    {
      name: 'byStatus',
      description: 'Article count grouped by current status.',
      pipeline: [
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ],
      cache: { ttlSeconds: 60 },
    },
    {
      name: 'byCategory',
      description: 'Published article count grouped by categoryId.',
      pipeline: [
        { $match: { status: 'published' } },
        { $group: { _id: '$categoryId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ],
      cache: { ttlSeconds: 60 },
    },
  ],
};
