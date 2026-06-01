module.exports = {
  path: 'product',
  collection: 'product',
  label: 'Product',
  pluralLabel: 'Products',
  displayField: 'name',
  fields: [
    { name: 'accountId', type: String, required: true, stamped: true },
    { name: 'userId', type: String, required: true, stamped: true },
    {
      name: 'name',
      type: String,
      example: 'Kindle',
      required: true,
      searchable: true,
    },
    {
      name: 'price',
      type: Number,
      index: true,
      widget: 'currency',
      format: 'currency:USD',
    },
    { name: 'description', type: String },
    {
      name: 'sku',
      type: String,
      index: true,
      required: true,
      label: 'SKU',
    },
    {
      name: 'manufacturer',
      type: String,
      example: 'GTS',
    },
    {
      name: 'categories',
      type: Array,
      index: true,
    },
  ],
  compositeIndex: [
    {
      accountId: 1,
      sku: 1,
    },
  ],
  auth: {
    write: {
      fields: [
        // 'userId',
        'accountId',
      ],
      // comparison: '$and'
    },
  },
};
