
  module.exports =  {
    path: 'product',
    collection: 'product',
    fields: [
      {
        name: 'accountId',
        type: String,
        required: true
      },
      {
        name: 'userId',
        type: String,
        required: true
      },
      {
        name: 'name',
        type: String,
        example: 'Kindle',
        required: true
      },
      {
        name: 'price',
        type: Number,
        index: true
      },
      {
        name: 'description',
        type: String
      },
      {
        name: 'sku',
        type: String,
        index: true,
        required: true
      },
      {
        name: 'manufacturer',
        type: String,
        example: "GTS"
      },
      {
        name: 'categories',
        type: Array,
        index: true
      }
    ],
    compositeIndex: [
      {
        accountId: 1,
        sku: 1
      }
    ],
    auth: {
      write: {
        fields: [
          // 'userId',
          'accountId'
        ],
        // comparison: '$and'
      }
    },
    hooks: {
      before: (req) => {
        console.log('body', req.body);
        console.log(req.user);
        req.test = "somestring";
        return;
      }
    }
  };

