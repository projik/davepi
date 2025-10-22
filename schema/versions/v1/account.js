  module.exports =  {
    path: 'account',
    collection: 'account',
    fields: [
      {
        name: 'userId',
        type: String,
        required: true
      },
      {
        name: 'accountName',
        type: String,
        required: true
      },
      {
        name: 'description',
        type: String
      }
    ]
  };

