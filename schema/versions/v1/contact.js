module.exports = {
  path: 'contact',
  collection: 'contact',
  label: 'Contact',
  pluralLabel: 'Contacts',
  displayField: 'first_name',
  fields: [
    {
      name: 'accountId',
      type: String,
      required: true,
      // Tenant marker — stamped from the JWT. Not a parent FK against
      // the `account` collection (no belongsTo declared), so the admin
      // UI hides it from forms rather than offering a relation picker.
      stamped: true,
    },
    {
      name: 'userId',
      type: String,
      required: true,
      stamped: true,
    },
    {
      name: 'first_name',
      type: String,
      required: true,
      label: 'First name',
      searchable: true,
    },
    {
      name: 'last_name',
      type: String,
      label: 'Last name',
      searchable: true,
    },
    { name: 'company', type: String, searchable: true },
    { name: 'email', type: String, widget: 'email' },
    { name: 'phone', type: String },
    { name: 'mobile', type: String },
    { name: 'address1', type: String, label: 'Address line 1' },
    { name: 'address2', type: String, label: 'Address line 2' },
    { name: 'suburb', type: String },
    { name: 'state', type: String },
    { name: 'postcode', type: String },
    { name: 'country', type: String },
  ],
};
