  module.exports =  {
    path: 'quote',
    collection: 'quote',
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
        name: 'contactId',
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
      }
    ]
  };

