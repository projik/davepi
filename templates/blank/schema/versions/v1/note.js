module.exports = {
  path: 'note',
  collection: 'note',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'title', type: String, required: true, searchable: true },
    { name: 'body', type: String, searchable: true },
    { name: 'pinned', type: Boolean, default: false },
  ],
};
