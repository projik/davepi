  module.exports =  {
    path: 'project',
    collection: 'project',
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
        required: true
      },
      {
        name: 'description',
        type: String
      },
      {
        name: "products",
        type: [String]
      },
      {
        name: 'parent',
        type: String
      }
    ]
  };

