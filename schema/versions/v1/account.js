module.exports = {
  path: 'account',
  collection: 'account',
  // Display hints surfaced through `/_describe` for agent + admin
  // consumers (davepi-ui in particular). Pure metadata — the framework
  // doesn't read these for routing.
  label: 'Account',
  pluralLabel: 'Accounts',
  displayField: 'accountName',
  fields: [
    {
      name: 'userId',
      type: String,
      required: true,
      // Stamped from the JWT by the auto-generated POST/PUT handlers;
      // a client-supplied value is ignored. Tells admin UIs to hide
      // this field from create / edit forms instead of letting users
      // attempt a doomed override.
      stamped: true,
    },
    {
      name: 'accountName',
      type: String,
      required: true,
      // Intentionally not `searchable: true` — `test/full-text-search.test.js`
      // and `test/public-read.test.js` use `account` as the canonical
      // example of a schema with no searchable fields (verifies the
      // text-index opt-in is honoured + the GraphQL `search` arg and
      // Swagger `__q` parameter are hidden when absent).
    },
    {
      name: 'description',
      type: String,
    },
  ],
};
