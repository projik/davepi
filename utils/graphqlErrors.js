const { GraphQLError } = require('graphql');

// Apollo Server v4 dropped the named error classes that
// `apollo-server-express` (v3) re-exported from `apollo-server-errors`
// — `AuthenticationError`, `ForbiddenError`, `ApolloError`, … The
// replacement is a plain `GraphQLError` whose `extensions.code` carries
// the same value the v3 classes set. By reproducing those codes here we
// keep the on-the-wire error shape (`errors[].extensions.code`)
// byte-for-byte identical to v3, so existing GraphQL clients and the
// test suite (which assert on `UNAUTHENTICATED` / `FORBIDDEN` /
// `INVALID_TRANSITION`) keep passing without change.
//
// This is the single place the framework mints typed GraphQL errors;
// resolvers and scope wrappers import from here rather than reaching
// for `graphql` directly, mirroring how REST handlers throw from
// `utils/errors.js`.

class AuthenticationError extends GraphQLError {
  constructor(message, extensions) {
    super(message, { extensions: { ...extensions, code: 'UNAUTHENTICATED' } });
    this.name = 'AuthenticationError';
  }
}

class ForbiddenError extends GraphQLError {
  constructor(message, extensions) {
    super(message, { extensions: { ...extensions, code: 'FORBIDDEN' } });
    this.name = 'ForbiddenError';
  }
}

// v3's `new ApolloError(message, code, properties)` put `code` on
// `extensions.code` and spread `properties` onto `extensions`. This is
// the GraphQLError-native equivalent — used for the typed
// `INVALID_TRANSITION` error whose structured payload rides
// `extensions.details`.
class ApolloError extends GraphQLError {
  constructor(message, code, properties) {
    super(message, { extensions: { ...properties, code } });
    this.name = 'ApolloError';
  }
}

module.exports = { AuthenticationError, ForbiddenError, ApolloError };
