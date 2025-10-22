  module.exports =  {
    path: 'contact',
    collection: 'contact',
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
        name: 'first_name',
        type: String,
        required: true
      },
      {
        name: 'last_name',
        type: String
      },
      {
        name: 'company',
        type: String
      },
      {
        name: "email",
        type: String
      },
      {
        name: "phone",
        type: String
      },
      {
        name: 'mobile',
        type: String
      },
      {
        name: 'address1',
        type: String
      },
      {
        name: 'address2',
        type: String
      },
      {
        name: 'suburb',
        type: String
      },
      {
        name: 'state',
        type: String
      },
      {
        name: 'postcode',
        type: String
      },
      {
        name: 'country',
        type: String
      }
    ]
  };

