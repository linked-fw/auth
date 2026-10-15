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
 * The namespace of this ontology, which can be used to create NamedNodes with URI's not listed in this file.
 *
 * First-party ontologies live on linked.cm: `https://linked.cm/ont/{ontologySlug}/`, and a
 * package's own ontology takes the package's publicSlug (`@_linked/auth` → `auth`), the same slug
 * its shapes use under `https://linked.cm/shape/auth/`.
 *
 * Until 2.0 this was `http://lincd.org/ont/auth/`. Data stored under that namespace is invisible
 * to this release until it is rewritten — see `migrateAuthNamespace` in
 * `@_linked/auth/utils/migrateNamespace`.
 */
export var ns = createNameSpace('https://linked.cm/ont/auth/');

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
export var forgotPasswordTokenExpiresAt = ns('forgotPasswordTokenExpiresAt');
/** A random marker an atomic reset token consume writes, to learn whether its update matched. */
export var passwordResetConsumeMarker = ns('passwordResetConsumeMarker');
/** When the person proved control of the credential's email (opened a link sent to it). */
export var emailVerifiedAt = ns('emailVerifiedAt');
export var emailVerificationToken = ns('emailVerificationToken');
export var emailVerificationTokenExpiresAt = ns('emailVerificationTokenExpiresAt');
/** The same marker for an email verification token consume. */
export var emailVerificationConsumeMarker = ns('emailVerificationConsumeMarker');
/** The hash of an emailed sign-in code, bound to the email it was sent to. */
export var signinCode = ns('signinCode');
export var signinCodeExpiresAt = ns('signinCodeExpiresAt');
/** The same marker for a sign-in code consume. */
export var signinCodeConsumeMarker = ns('signinCodeConsumeMarker');
/** The email a pending credential (of nobody yet) holds sign-in codes for. */
export var signinCodeEmail = ns('signinCodeEmail');
export var telephone = ns('telephone');
export var hash = ns('hash');
export var tokenHash = ns('tokenHash');
export var sessionId = ns('sessionId');
export var createdAt = ns('createdAt');
export var lastUsedAt = ns('lastUsedAt');
export var expiresAt = ns('expiresAt');
export var revokedAt = ns('revokedAt');
export var replacedBy = ns('replacedBy');
export var sessionStartedAt = ns('sessionStartedAt');
/** The OAuth provider ('google', 'apple', 'facebook') an IdentityToken's subject belongs to. */
export var identityProvider = ns('identityProvider');
export var UsedOAuthNonce = ns('UsedOAuthNonce');
export var nonceHash = ns('nonceHash');

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
  forgotPasswordTokenExpiresAt,
  passwordResetConsumeMarker,
  emailVerifiedAt,
  emailVerificationToken,
  emailVerificationTokenExpiresAt,
  emailVerificationConsumeMarker,
  signinCode,
  signinCodeExpiresAt,
  signinCodeConsumeMarker,
  signinCodeEmail,
  telephone,
  hash,
  tokenHash,
  sessionId,
  createdAt,
  lastUsedAt,
  expiresAt,
  revokedAt,
  replacedBy,
  sessionStartedAt,
  identityProvider,
  UsedOAuthNonce,
  nonceHash,
};

