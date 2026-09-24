import { createNameSpace } from '@_linked/core/utils/NameSpace';

/**
 * Load the data of this ontology into memory, thus adding the properties of the entities of this ontology to the local graph.
 */
export var loadData = () => {
  //@ts-ignore
  return import('../data/auth.json', { with: { type: 'json' } }).then(
    (data) => data.default
  );
};

/**
 * The namespace of this ontology, which can be used to create NamedNodes with URI's not listed in this file
 */
export var ns = createNameSpace('http://lincd.org/ont/auth/');

/**
 * The NamedNode of the ontology itself
 */
export var _self = ns('');

//A list of all the entities (Classes & Properties) of this ontology, each exported as a NamedNode
export var Authentication = ns('Authentication');
export var userAccount = ns('userAccount');
export var IdentityToken = ns('IdentityToken');
export var AuthCredential = ns('AuthCredential');
export var RefreshToken = ns('RefreshToken');
export var Password = ns('Password');

export var credentialOf = ns('credentialOf');
export var token = ns('token');
export var subject = ns('subject');
export var email = ns('email');
export var account = ns('account');
export var passwordHash = ns('passwordHash');
export var phoneIdentifier = ns('phoneIdentifier');
export var forgotPasswordToken = ns('forgotPasswordToken');
export var telephone = ns('telephone');
export var hash = ns('hash');

//An extra grouping object so all the entities can be accessed from the prefix/name
export const auth = {
  Authentication,
  userAccount,
  IdentityToken,
  AuthCredential,
  RefreshToken,
  Password,
  credentialOf,
  token,
  email,
  phoneIdentifier,
  subject,
  account,
  passwordHash,
  forgotPasswordToken,
  telephone,
  hash,
};

