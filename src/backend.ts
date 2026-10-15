import { Person as SchemaPerson } from '@_linked/schema/shapes/Person';
import type { Shape } from '@_linked/core/shapes/Shape';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { declareCallable, declareInternal } from '@_linked/server-utils/utils/callable';
import { requireSessionUser } from '@_linked/server-utils/utils/CallContext';
import session from 'express-session';

import { Auth } from './utils/auth.js';
import { AuthCredential } from './shapes/AuthCredential.js';
import { auth } from './ontologies/auth.js';
import { expressjwt, Request } from 'express-jwt';
import cookieParser from 'cookie-parser';
import type {
  AuthSessionPayload,
  AuthenticationResult,
  CreateAccount,
  LinkOAuthIdentityResult,
  OAuthProvider,
  ReauthenticationMethod,
  RemoveAccountProof,
  RemoveAccountResult,
  ResendEmailVerificationResult,
  UserAccountData,
  UserData,
  VerifiedOAuthIdentity,
  VerifyEmailResult,
} from './types/auth.js';
import {
  createAccessToken,
  verifyAccessToken,
  verifyToken,
} from './utils/jwt.js';
import {
  deleteAllSessionsForAccount,
  findRefreshTokenExpiry,
  findSessionIdForRefreshToken,
  revokeAllSessionsForAccount,
  revokeSession,
  rotateRefreshToken,
  startSessionCleanup,
  stopSessionCleanup,
} from './utils/sessions.js';
import { clearAuthCookies, deliverTokens } from './utils/cookies.js';
import { assertAuthSecrets, FatalConfigError } from './utils/secrets.js';
import { buildClientIdDocument, CLIENT_ID_DOCUMENT_PATH } from './utils/clientIdDocument.js';
import { refreshTokenExpiryFields } from './utils/token.js';
import {
  emitAccountWillBeRemovedEvent,
  onAccountWillBeRemoved,
  offAccountWillBeRemoved,
} from './utils/events.js';
import AppleHelper from './helpers/apple.js';
import GoogleHelper from './helpers/google.js';
import PasswordHelper, {
  INVALID_CREDENTIALS_MESSAGE,
  INVALID_PASSWORD_RESULT,
  isAcceptablePassword,
} from './helpers/password.js';
import { IdentityToken } from './shapes/IdentityToken.js';
import { decideEmailMatchedAccount } from './helpers/oauth-account.js';
import { OAuthIdentityStore } from './utils/oauthIdentities.js';
import { checkAppleNonce, issueOAuthNonce } from './utils/oauthNonce.js';
import type { OAuthIdentityLink } from './utils/oauthIdentities.js';
import path, { dirname, basename } from 'path';
import { escapeHtml, sendAuthEmail } from './utils/email.js';
import {
  clearUnsentToken,
  consumeCredentialToken,
  consumeCredentialTokenRecord,
  hashToken,
  TOKEN_KINDS,
} from './helpers/credentialToken.js';
import {
  generateSigninCode,
  normalizeSigninCode,
  normalizeSigninEmail,
  signinCodeFields,
  signinCodeSecret,
} from './helpers/signinCode.js';
import {
  markEmailVerified,
  personEmailVerified,
  verificationTokenFields,
} from './helpers/emailVerification.js';
import { REAUTH_MAX_TOKEN_AGE } from './helpers/reauthentication.js';
import { QResult } from '@_linked/core/queries/SelectQuery';
import type { AuthSession } from './types/auth.js';

import connect_sqlite3 from 'connect-sqlite3';
import { limitRequest } from './utils/rateLimit.js';

var SQLiteStore = connect_sqlite3(session);

/**
 * The OAuth providers `signinOAuth` verifies cryptographically. Any other provider (facebook
 * included) is rejected: without verification its email would be the client's word.
 */
const VERIFIED_OAUTH_PROVIDERS: readonly string[] = ['google', 'apple'];

/**
 * The name of the express-session cookie. It used to be the package name, `@_linked/auth`, which
 * `cookie.serialize` rejects ("argument name is invalid"): every response that wrote
 * `req.session` threw while sending its headers and never finished.
 */
export const SESSION_COOKIE_NAME = 'linked.auth';

declare var process;

/**
 * The credential to check a password against: the first one with a password hash, otherwise
 * the first one (which then has no password).
 */
function preferCredentialWithPassword<C extends { passwordHash?: string }>(
  credentials: C[] | null | undefined
): C | undefined {
  if (!credentials?.length) return undefined;
  return credentials.find((credential) => Boolean(credential.passwordHash)) ?? credentials[0];
}
// OAuth sign-in helpers live outside the provider class on purpose: every method of a backend
// provider can be dispatched over `/call/<package>/<method>`, and none of these may be reachable
// from a client.

/**
 * Verify a provider credential on the server and return only what the provider vouches for.
 * Profile fields the client sent never decide the account; the only client values kept are
 * Apple's names, which Apple hands to the client (once) instead of putting them in the token.
 */
async function verifyOAuthIdentity(
  provider: OAuthProvider,
  oauthUserData: Record<string, any>
): Promise<VerifiedOAuthIdentity | { error: string }> {
  if (provider === 'apple') {
    const identityToken = oauthUserData.identityToken;
    if (!identityToken || typeof identityToken !== 'string') {
      console.error('Apple OAuth: No identity token provided');
      return { error: 'No Apple identity token provided' };
    }
    const apple = await AppleHelper.decodeIdentityToken(identityToken);
    if (!apple) {
      console.error('Apple OAuth: Invalid identity token');
      return { error: 'Invalid Apple identity token' };
    }
    const nonceProblem = await checkAppleNonce(apple.nonce, oauthUserData.nonce);
    if (nonceProblem) {
      console.error(`Apple OAuth: ${nonceProblem}`);
      return { error: nonceProblem };
    }
    return {
      provider,
      subject: apple.sub,
      email: apple.email,
      // decodeIdentityToken refuses a token whose email is not verified
      emailVerified: Boolean(apple.email),
      givenName: stringOrUndefined(oauthUserData.givenName),
      familyName: stringOrUndefined(oauthUserData.familyName),
      issuedAt: issuedAtOf(apple.iat),
    };
  }

  if (provider === 'google') {
    const idToken = oauthUserData.authentication?.idToken;
    if (!idToken || typeof idToken !== 'string') {
      console.error('Google OAuth: No ID token provided');
      return { error: 'No Google ID token provided' };
    }
    const google = await GoogleHelper.validateIdToken(idToken);
    if (!google) {
      console.error('Google OAuth: Invalid ID token');
      return { error: 'Invalid Google ID token' };
    }
    return {
      provider,
      subject: google.sub,
      email: google.email,
      emailVerified: google.email_verified === true,
      givenName: stringOrUndefined(google.given_name),
      familyName: stringOrUndefined(google.family_name),
      issuedAt: issuedAtOf(google.iat),
    };
  }

  return { error: 'Unsupported OAuth provider' };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A token's `iat` claim (seconds since the epoch) as a date. */
function issuedAtOf(iat: unknown): Date | undefined {
  return typeof iat === 'number' && Number.isFinite(iat) ? new Date(iat * 1000) : undefined;
}

/**
 * Whether anything already exists for this email: a person at its WebID, an account with the
 * email (stored as typed by older releases, or normalized), or a credential with the email or
 * of that person. Signup refuses all of them, so it never adds a second set of rows for an
 * email that someone already holds.
 */
async function emailAlreadyRegistered(
  provider: AuthBackendProvider,
  email: string,
  normalizedEmail: string,
  webID: string
): Promise<boolean> {
  const person = await provider.userShape.select((p) => [p.givenName]).for(webID);
  if (person) return true;

  const emails = email === normalizedEmail ? [normalizedEmail] : [normalizedEmail, email];
  for (const candidate of emails) {
    const account = await provider.accountShape
      .select((a) => [a.email])
      .where((a) => a.email.equals(candidate))
      .one();
    if (account) return true;
    const credential = await AuthCredential.select((c) => [c.email])
      .where((c) => c.email.equals(candidate))
      .one();
    if (credential) return true;
  }

  const credentialOfPerson = await AuthCredential.select((c) => [c.credentialOf])
    .where((c) => c.credentialOf.equals({ id: webID }))
    .one();
  return Boolean(credentialOfPerson);
}

/** An account with its person's profile, as sign-in returns it, or null when it is gone. */
async function loadAccountWithPerson(
  provider: AuthBackendProvider,
  accountId: string
): Promise<UserAccountData | null> {
  const account = await provider.accountShape
    .select((a) => [
      a.email,
      a.accountOf.select((p) => [p.givenName, p.familyName, p.telephone]),
    ])
    .for({ id: accountId });
  return (account as unknown as UserAccountData) || null;
}

/** The stored email of an account, else the one in its session, else ''. */
async function accountEmail(
  provider: AuthBackendProvider,
  account: UserAccountData
): Promise<string> {
  try {
    const stored = await provider.accountShape.select((a) => [a.email]).for({ id: account.id });
    if (stored?.email) return stored.email;
  } catch (error) {
    console.warn('Could not read the email of an account', error);
  }
  const sessionEmail: unknown = (account as { email?: unknown }).email;
  return typeof sessionEmail === 'string' ? sessionEmail : '';
}

/** The given name of a person, for an email greeting, if it can be read. */
async function givenNameOf(
  provider: AuthBackendProvider,
  personId: string
): Promise<string | undefined> {
  try {
    const person = await provider.userShape
      .select((u) => u.givenName)
      .for({ id: personId })
      .one();
    return typeof person?.givenName === 'string' && person.givenName ? person.givenName : undefined;
  } catch {
    return undefined;
  }
}

type OAuthAccountMatch = {
  account?: UserAccountData;
  personId?: string;
  conflict?: true;
};

/**
 * Resolve a verified OAuth email to an existing person/account.
 *
 * Older applications did not derive a person's WebID from `webid.email`, so checking only the
 * current canonical WebID creates a duplicate account for those users. Account and credential
 * email are therefore compatibility identifiers here. All matches are collected before choosing:
 * if they disagree about the person or account, sign-in fails closed instead of selecting an
 * arbitrary row.
 */
async function findAccountForOAuthEmail(
  provider: AuthBackendProvider,
  webID: string,
  providerEmail: string,
  normalizedEmail: string
): Promise<OAuthAccountMatch> {
  const accountsById = new Map<string, UserAccountData>();
  const personIds = new Set<string>();

  const rememberAccount = (value: unknown) => {
    const account = value as UserAccountData | null;
    if (!account?.id || !account.accountOf?.id) return;
    accountsById.set(account.id, account);
    personIds.add(account.accountOf.id);
  };

  const selectAccounts = () =>
    provider.accountShape.select((account) => [
      account.email,
      account.accountOf.select((person) => [
        person.givenName,
        person.familyName,
        person.telephone,
      ]),
    ]);

  const canonicalAccount = await selectAccounts()
    .where((account) => account.accountOf.equals({ id: webID }))
    .one();
  rememberAccount(canonicalAccount);

  const canonicalPerson = await provider.userShape.select((person) => [person.givenName]).for(webID);
  if (canonicalPerson?.id) personIds.add(canonicalPerson.id);

  const emails = [...new Set([providerEmail.trim(), normalizedEmail])];
  for (const email of emails) {
    const emailAccounts = await selectAccounts()
      .where((account) => account.email.equals(email));
    for (const account of emailAccounts || []) rememberAccount(account);

    const credentials = await AuthCredential.select((credential) => [credential.credentialOf])
      .where((credential) => credential.email.equals(email));
    for (const credential of credentials || []) {
      const personId = credential.credentialOf?.id;
      if (!personId) continue;
      personIds.add(personId);
      const accounts = await selectAccounts()
        .where((account) => account.accountOf.equals({ id: personId }));
      for (const account of accounts || []) rememberAccount(account);
    }
  }

  if (personIds.size > 1 || accountsById.size > 1) return { conflict: true };
  return {
    account: accountsById.values().next().value,
    personId: personIds.values().next().value,
  };
}

// The configured user shape (`Auth.userType`). Historically `SchemaPerson | FoafPerson`;
// `foaf` was the last legacy `lincd` package in this dependency tree and the
// union was type-only, so this widens to the same `typeof Shape` that
// `AuthProviderProps.userType` already used.
type Person = Shape;

export * from './shapes/AuthCredentialProvider.js';

const filename__ =
  typeof __filename !== 'undefined'
    ? __filename
    : //@ts-ignore
      basename(import.meta.url).replace('file:/', '');

/**
 * Email the verification link for `token` (already stored, hashed, on a credential) to `email`.
 * When the email is not sent, the stored token is removed again.
 *
 * @returns false when the email could not be sent
 */
async function sendVerificationEmail(
  email: string,
  givenName: string | undefined,
  token: string,
  tokenHash: string
): Promise<boolean> {
  const verifyUrl = `${process.env.SITE_ROOT}/auth/verify-email?token=${token}`;
  const emailOptions = {
    to: [
      {
        email_address: {
          address: email,
          name: email,
        },
      },
    ],
    subject: `Verify your ${process.env.APP_NAME} email address`,
    htmlbody: `
          <table role='presentation' border='0' cellpadding='0' cellspacing='0' class='body' style='border-collapse: separate; mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #fff; width: 100%;' width='100%' bgcolor='#fff'>
            <tr>
              <td>
                <p>Hey${givenName ? ` ${escapeHtml(givenName)}` : ''} 👋</p>
                <p>Click the button below to confirm your email address:</p>
                <a href='${escapeHtml(verifyUrl)}' target='_blank' style='border: solid 1px #3498db; border-radius: 5px; box-sizing: border-box; cursor: pointer; display: inline-block; font-size: 14px; font-weight: bold; margin: 0; padding: 12px 25px; text-decoration: none; text-transform: capitalize; background-color: #3498db; border-color: #3498db; color: #ffffff;'>Verify Email</a>
                <p>Cheers,</p>
                <p>${escapeHtml(process.env.APP_NAME)} Team</p>
              </td>
            </tr>
            <tr>
              <td>
                <p style='font-size: 12px; color: #999;'>Alternatively, you can also copy and paste the link into your browser:</p>
                <a href='${escapeHtml(verifyUrl)}' target='_blank' style='font-size: 12px;'>${escapeHtml(verifyUrl)}</a>
              </td>
            </tr>
          </table>
        `,
  };
  const outcome = await sendAuthEmail(emailOptions, { purpose: 'verify', url: verifyUrl });
  if (outcome === 'failed') {
    await clearUnsentToken('verify', tokenHash);
    return false;
  }
  return true;
}

/**
 * After an OAuth sign-in reached `personId`: the provider vouches for its email, so when that
 * email is the person's (it gives their WebID), the person's email counts as verified. A failure
 * is logged and never fails the sign-in.
 */
async function markOAuthEmailVerified(identity: VerifiedOAuthIdentity, personId: string) {
  if (!identity.email || !identity.emailVerified) return;
  try {
    const email = identity.email.trim().toLowerCase();
    if (Auth.webIdFor(email) !== personId) return;
    await markEmailVerified(personId, email);
  } catch (error) {
    console.error(`${identity.provider} sign-in: could not mark the email verified`, error);
  }
}

/** What every refused code sign-in answers: wrong, expired, used, or for another email. */
export const INVALID_SIGNIN_CODE_MESSAGE = 'This sign-in code is invalid or has expired.';

/**
 * Store `fields` (a new sign-in code) on the credential that holds codes for `email`, replacing
 * any earlier code: the credential of the person at `webID`, else of the person whose account has
 * the email, else the pending credential for the email (see
 * `AuthCredential.signinCodeEmailHash`), created when there is none yet.
 *
 * @returns the id of the person the code signs in to, if the email has one yet
 */
async function storeSigninCode(
  provider: AuthBackendProvider,
  email: string,
  webID: string,
  fields: ReturnType<typeof signinCodeFields>
): Promise<string | undefined> {
  const byWebID = await provider.getPasswordForUser({ id: webID });
  if (byWebID) {
    await AuthCredential.update(fields).for({ id: byWebID.id });
    return webID;
  }

  const personId = await personOfAccountEmail(email);
  if (personId) {
    const ofPerson = await provider.getPasswordForUser({ id: personId });
    if (ofPerson) {
      await AuthCredential.update(fields).for({ id: ofPerson.id });
    } else {
      await AuthCredential.create({ credentialOf: { id: personId }, email, ...fields });
    }
    return personId;
  }

  const emailHash = hashToken(email);
  const pending = await AuthCredential.select((c) => [c.signinCodeEmailHash])
    .where((c) => c.signinCodeEmailHash.equals(emailHash))
    .one();
  if (pending) {
    await AuthCredential.update(fields).for({ id: pending.id });
  } else {
    await AuthCredential.create({ signinCodeEmailHash: emailHash, ...fields });
  }
  return undefined;
}

/** The person of the account whose email is `email`, if there is one. */
async function personOfAccountEmail(email: string): Promise<string | undefined> {
  const account = await UserAccount.select((ua) => [ua.email, ua.accountOf])
    .where((ua) => ua.email.equals(email))
    .one();
  return account?.accountOf?.id || undefined;
}

/** The email with a sign-in code and the link that carries it. */
function signinCodeMessage(
  email: string,
  givenName: string | undefined,
  code: string,
  signinUrl: string
) {
  const minutes = Math.round(TOKEN_KINDS.signinCode.ttl / 60);
  return {
    to: [{ email_address: { address: email, name: email } }],
    subject: `Your ${process.env.APP_NAME} sign-in code: ${code}`,
    htmlbody: `
          <table role='presentation' border='0' cellpadding='0' cellspacing='0' class='body' style='border-collapse: separate; mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #fff; width: 100%;' width='100%' bgcolor='#fff'>
            <tr>
              <td>
                <p>Hey${givenName ? ` ${escapeHtml(givenName)}` : ''} 👋</p>
                <p>Click the button below to sign in to ${escapeHtml(process.env.APP_NAME)}:</p>
                <a href='${escapeHtml(signinUrl)}' target='_blank' style='border: solid 1px #3498db; border-radius: 5px; box-sizing: border-box; cursor: pointer; display: inline-block; font-size: 14px; font-weight: bold; margin: 0; padding: 12px 25px; text-decoration: none; text-transform: capitalize; background-color: #3498db; border-color: #3498db; color: #ffffff;'>Sign in</a>
                <p>Or type this code where you asked for it:</p>
                <p style='font-size: 24px; font-weight: bold; letter-spacing: 4px;'>${escapeHtml(code)}</p>
                <p>The code and the link work once, for ${minutes} minutes. If you did not ask to sign in, you can ignore this email.</p>
                <p>Cheers,</p>
                <p>${escapeHtml(process.env.APP_NAME)} Team</p>
              </td>
            </tr>
            <tr>
              <td>
                <p style='font-size: 12px; color: #999;'>Alternatively, you can also copy and paste the link into your browser:</p>
                <a href='${escapeHtml(signinUrl)}' target='_blank' style='font-size: 12px;'>${escapeHtml(signinUrl)}</a>
              </td>
            </tr>
          </table>
        `,
  };
}

const REAUTH_MISSING_MESSAGE = 'Confirm it is you to delete this account.';
const REAUTH_MISMATCH_MESSAGE = 'That confirmation did not match this account.';

function isReauthenticationProvider(provider: unknown): provider is 'google' | 'apple' {
  return typeof provider === 'string' && VERIFIED_OAUTH_PROVIDERS.includes(provider);
}

/**
 * What the account can confirm it is the account holder with: its password when it has one,
 * otherwise its linked Google/Apple identities. None (temporary and dev accounts): a session is
 * all there is to check.
 */
async function reauthenticationMethods(
  accountId: string,
  personId: string
): Promise<ReauthenticationMethod[]> {
  if (await OAuthIdentityStore.personHasPassword(personId)) return ['password'];
  return (await OAuthIdentityStore.findLinkedProviders(accountId)).filter(
    isReauthenticationProvider
  );
}

/** Whether `proof` was sent at all, as opposed to checked: a password or a provider. */
function hasReauthenticationProof(proof: unknown): proof is Record<string, unknown> {
  return (
    typeof proof === 'object' &&
    proof !== null &&
    ('password' in proof || 'provider' in proof)
  );
}

/**
 * Check a deletion proof against the account. Any valid proof counts, not only the preferred
 * method: a linked Google identity is as strong as the password.
 *
 * - `{password}`: checked against the person's password, as a password change checks it.
 * - `{provider, source}`: verified exactly as `signinOAuth` verifies it (signature, audience,
 *   expiry, Apple's nonce), issued no more than `REAUTH_MAX_TOKEN_AGE` ago, and its subject
 *   linked to this account.
 */
async function verifyReauthentication(
  provider: AuthBackendProvider,
  accountId: string,
  personId: string,
  proof: Record<string, unknown>,
  now: number = Date.now()
): Promise<boolean> {
  if ('password' in proof) {
    if (typeof proof.password !== 'string' || !proof.password) return false;
    const credential = await provider.getPasswordForUser({ id: personId });
    if (!credential?.passwordHash) return false;
    return PasswordHelper.checkPassword(proof.password, credential.passwordHash);
  }

  if (!isReauthenticationProvider(proof.provider)) return false;
  const source = proof.source;
  if (typeof source !== 'object' || source === null) return false;
  const identity = await verifyOAuthIdentity(proof.provider, source as Record<string, unknown>);
  if ('error' in identity) return false;
  if (!identity.issuedAt || now - identity.issuedAt.getTime() > REAUTH_MAX_TOKEN_AGE) {
    console.warn(`${proof.provider} confirmation refused: the ID token is not fresh`);
    return false;
  }
  // a valid token of some other Google/Apple user proves nothing about this account
  const links = await OAuthIdentityStore.findLinks(proof.provider, identity.subject);
  return links.some((link) => link.accountId === accountId);
}

/**
 * The app's Client ID Document as JSON, when `Auth.signinClient` is set; `undefined` otherwise,
 * so nothing is served. Built once at startup: invalid theme values are logged and left out, and
 * a SITE_ROOT or configured URL an issuer would reject stops the server from starting. The path is
 * under `.well-known`, which the token check skips.
 */
function clientIdDocumentBody(): string | undefined {
  const config = Auth.signinClient;
  if (!config) return undefined;
  let built: ReturnType<typeof buildClientIdDocument>;
  try {
    built = buildClientIdDocument(config, process.env.SITE_ROOT ?? '');
  } catch (err) {
    throw new FatalConfigError((err as Error).message);
  }
  for (const { path, value, reason } of built.problems) {
    console.warn(
      `[auth] Client ID Document: dropped theme value ${path || '(theme)'} = ${JSON.stringify(value)}: ${reason}`
    );
  }
  return JSON.stringify(built.document);
}

export default class AuthBackendProvider extends BackendProvider {
  public accountShape: typeof UserAccount = UserAccount;
  public userShape: typeof SchemaPerson = SchemaPerson;
  // Plan-011 — store the listener so dispose() can unsubscribe it.
  // Anonymous inline callbacks would leak across HMR reloads.
  private accountRemovedListener?: (account: UserAccountData) => Promise<void>;

  async setupBeforeControllers() {
    // Fail at startup, not on the first sign-in, when a production deployment lacks its secrets.
    // This is the first thing the package runs at boot. The error is a FatalConfigError
    // (`fatal: true`), which @_linked/server re-throws to abort startup instead of logging the
    // failed hook and serving with broken auth.
    const { jwtSecret, sessionSecret } = assertAuthSecrets(filename__);

    //if defined, take the values from the environment variables to define the shapes for the account and user
    await this.assignEnvPathToField('AUTH_ACCOUNT_TYPE', 'accountShape');
    await this.assignEnvPathToField('AUTH_USER_TYPE', 'userShape');

    this.accountRemovedListener = async (account: UserAccountData) => {
      try {
        await deleteAllSessionsForAccount(account?.id);
      } catch (err) {
        console.error('Could not delete the refresh tokens of a removed account', err);
      }
    };
    onAccountWillBeRemoved(this.accountRemovedListener);

    // Delete long-revoked/expired refresh token records in the background (at most daily per
    // process; AUTH_SESSION_CLEANUP=false turns it off).
    startSessionCleanup();

    // set the user and account shapes for auth
    Auth.userType = this.userShape;
    Auth.accountType = this.accountShape;

    const clientIdDocument = clientIdDocumentBody();
    if (clientIdDocument) {
      this.registerRoute('get', CLIENT_ID_DOCUMENT_PATH, (_req, res) => {
        res.set('Content-Type', 'application/ld+json');
        res.set('Cache-Control', 'public, max-age=600');
        res.send(clientIdDocument);
      });
    }

    // FOR initial page requests we send the JWT token as a cookie (Stored in the browser)
    // see getToken for how we use the cookie and set this.request.linkedAuth
    // registerRoute tracks these so dispose() can remove them on HMR.
    this.registerRoute('use', '/', cookieParser());

    // For API requests, we send a token as the Bearer header
    // It gets parsed by this middleware and the result is that
    // on getToken we catch first every request and check the headers or cookies
    // and if has, we set into this.request.linkedAuth
    this.registerRoute(
      'use',
      '/',
      expressjwt({
        secret: jwtSecret,
        algorithms: ['HS256'],
        // getToken below only hands over verified access tokens; this repeats the audience check
        // for the verification express-jwt does itself.
        ...(process.env.SITE_ROOT ? { audience: process.env.SITE_ROOT } : {}),
        credentialsRequired: false, // allows unauthenticated requests to pass through
        getToken: async (
          req: Request & { auth: AuthSessionPayload } & {
            linkedAuth: AuthSession;
          }
        ): Promise<string> => {
          return this.validateRequestToken(req);
        },
        // An expired access token leaves the request anonymous (req.auth stays undefined).
        // It is NOT refreshed here: a token minted in middleware never reaches the client, and
        // rotating the refresh token without delivering the new one would make the client's next
        // refresh look like token theft. Clients refresh through the validateToken RPC.
        onExpired: async () => {},
      }).unless({
        // Skip token verification for all static assets
        path: [
          /^\/public\/.*/, // anything under /public
          /^\/uploads\/.*/, // anything under /uploads
          /^\/resized\/.*/, // dynamically‑resized images
          /^\/favicon\.ico$/, // favicon
          /^\/\.well-known\/.*/, // ACME challenges etc.
        ],
      })
    );

    this.registerRoute(
      'use',
      '/',
      session({
        secret: sessionSecret,
        name: SESSION_COOKIE_NAME,
        //TODO: this broke sessions in production, need to check what else we need to do to make secure sessions work
        // cookie: {secure: process.env.NODE_ENV === 'production'},
        resave: true,
        saveUninitialized: false,
        store: new SQLiteStore({
          dir: path.join(process.cwd(), 'data'),
        }),
      })
    );
  }

  async dispose() {
    // Plan-011 — remove the middleware we tracked above + unsubscribe
    // the account-removed listener so HMR doesn't leak handlers.
    this.disposeRoutes();
    stopSessionCleanup();
    if (this.accountRemovedListener) {
      offAccountWillBeRemoved(this.accountRemovedListener);
      this.accountRemovedListener = undefined;
    }
  }

  /**
   * Authenticate an incoming request from its access token (Bearer header or `accessToken`
   * cookie). Only a valid access token counts; refresh tokens are never accepted here.
   *
   * @returns the access token if it is valid, otherwise null
   */
  async validateRequestToken(request, _accessTokenExpired: boolean = false) {
    // the Bearer header first, then the `accessToken` cookie (see getTokenCandidates)
    for (const token of this.getTokenCandidates(request)) {
      const verificationResult = await verifyToken({
        request,
        token,
        provider: this,
      });

      // if token is valid, set the authentication object
      if (verificationResult) {
        let authentication = await Auth.setAuthentication(
          request as any,
          verificationResult.payload
        );

        if (!authentication) {
          console.log(`GET TOKEN authentication: no authentication`);
          return null;
        }

        return verificationResult.accessToken;
      }
    }

    return null;
  }

  /**
   * Initialize the incoming request
   *
   * @param request - The incoming request
   * @param response - The outgoing response
   */
  async initRequest(request, response) {
    super.initRequest(request, response);
  }

  // TODO: check possible to remove this method?
  checkSignin() {
    //this is a temporary fix that allows the frontend to check if the user is still logged in on the backend
    return this.request?.linkedAuth?.userAccount;
  }

  /**
   * Supply data for the incoming request
   * This data will then be available on the frontend right upon initialisation
   *
   * @param request - The incoming request
   * @param response - The outgoing response
   * @param dataQuads - The set of data quads to be populated
   */
  async supplyDataForRequest(request, response, dataQuads: any): Promise<void> {
    //if logged in and we're collecting frontend data
    if (request.linkedAuth && request.frontendData) {
      const requestAuth = { ...request.linkedAuth };
      //Remove things that should not go to the frontend
      delete requestAuth.updateSessionData;
      //Store in the object that will be sent to the frontend
      request.frontendData.auth = requestAuth;
    }
  }

  /**
   * Sign in with email and password
   *
   * @param email - The email address
   * @param plainPassword - The plain password
   * @returns
   */
  async signinWithPassword(
    email: string,
    plainPassword: string
  ): Promise<AuthenticationResult> {
    // before anything is looked up, so the answer is the same whether the account exists or not
    const limited = await limitRequest('signin', this.request, this.response, email);
    if (limited) return limited;

    let webID: string;
    try {
      webID = Auth.webIdFor(email);
    } catch (error) {
      console.error('Invalid email format during signin');
      return {
        error: 'Invalid email format',
      };
    }

    // find any passwords for accounts with this email
    // and select the hash and account/person details
    let existingCredential = await this.getPasswordForUser({ id: webID });

    if (!existingCredential) {
      console.warn(
        'No password found for this WebID, checking the account by email'
      );

      // we get the user by email, if catch the user from here
      // we can say the user signup with temporary signin
      const account = await UserAccount.select((ua) => {
        return [ua.email, ua.accountOf];
      })
        .where((ua) => {
          return ua.email.equals(email);
        })
        .one();

      // every failure gives the same answer, and costs about as much as a wrong password
      if (!account?.accountOf?.id) {
        await PasswordHelper.compareWithDummyHash(plainPassword);
        return { error: INVALID_CREDENTIALS_MESSAGE };
      }

      existingCredential = preferCredentialWithPassword(
        await AuthCredential.select((ac) => {
          return [
            ac.passwordHash,
            ac.credentialOf.select((p) => {
              return [p.givenName, p.familyName, p.telephone];
            }),
          ];
        }).where((ac) => {
          return ac.credentialOf.equals({ id: account.accountOf.id });
        })
      );
    }

    if (!existingCredential?.passwordHash) {
      await PasswordHelper.compareWithDummyHash(plainPassword);
      return { error: INVALID_CREDENTIALS_MESSAGE };
    }

    const passwordIsValid = await PasswordHelper.checkPassword(
      plainPassword,
      existingCredential.passwordHash
    );

    if (!passwordIsValid) {
      return { error: INVALID_CREDENTIALS_MESSAGE };
    }

    await this.upgradePasswordHash(existingCredential, plainPassword);

    const person = existingCredential.credentialOf;

    const account = await this.getOrCreateAccount(person);

    return Auth.onSigninSuccessful(this, person, account);
  }

  /**
   * Re-hash a password that was just verified, if its stored hash has a lower cost than
   * `PASSWORD_HASH_COST`. Only `passwordHash` is written. A failure is logged and otherwise
   * ignored: it must never fail the sign-in, and the next sign-in tries again.
   */
  protected async upgradePasswordHash(
    credential: { id: string; passwordHash?: string },
    plainPassword: string
  ): Promise<void> {
    if (!PasswordHelper.needsRehash(credential.passwordHash)) return;
    try {
      const passwordHash = await PasswordHelper.generateHashedPassword(plainPassword);
      await AuthCredential.update({ passwordHash }).for({ id: credential.id });
    } catch (error) {
      console.error(`Could not upgrade the password hash of credential ${credential.id}:`, error);
    }
  }

  /**
   * Create a new account
   *
   * @param CreateAccount - The account data to create
   * @returns
   */
  async createAccount({
    firstName,
    lastName,
    email,
    password,
  }: CreateAccount): Promise<AuthenticationResult> {
    const limited = await limitRequest('signup', this.request, this.response);
    if (limited) return limited;

    // check if the first name and email are provided
    if (!firstName || !email) {
      return {
        error: 'No first name or email are provided',
      };
    }

    // before anything is looked up
    if (!isAcceptablePassword(password)) {
      return { ...INVALID_PASSWORD_RESULT };
    }

    let webIDFromEmail: string;
    try {
      webIDFromEmail = Auth.webIdFor(email);
    } catch (error) {
      console.error('Invalid email format during account creation');
      return {
        error: 'Invalid email format',
      };
    }
    const normalizedEmail = email.trim().toLowerCase();

    if (await emailAlreadyRegistered(this, email, normalizedEmail, webIDFromEmail)) {
      console.warn(
        `Account creation attempted with an email already in use (webID: ${webIDFromEmail})`
      );
      return {
        error:
          'This email address is already in use. Please choose another email or log in with your existing account.',
        action: 'change_email_or_log_in',
      };
    }

    // The new account is unverified until the link in this email is opened. Only its hash is
    // stored. Signup waits for the email to be sent, but works without an email provider: a
    // failed send only removes the token again.
    const verificationToken = PasswordHelper.generateToken();
    const verificationFields = verificationTokenFields(verificationToken);

    const result = await Auth.login(
      this,
      async () => {
        //we're not trying to log in with an existing account, a new one should be created
        return null;
      },
      async () => {
        //Create a user and a new new account.
        //NOTE: the user URI is now the webID of their profile.
        //And the webID is generated from their email (OR phonenumber)
        const user = await (this.userShape as any)
          .create({
            __id: webIDFromEmail,
            givenName: firstName,
            familyName: lastName,
            telephone: '',
          })
          .catch((err) => {
            console.error(`Error creating user ${webIDFromEmail}:`, err);
            throw new Error(`Could not create user ${webIDFromEmail}`);
          });

        // generate a new login credential for the user
        const passwordHash = await PasswordHelper.generateHashedPassword(
          password
        );
        await AuthCredential.create({
          credentialOf: {
            id: user.id,
          },
          email: normalizedEmail,
          passwordHash: passwordHash,
          ...verificationFields,
        }).catch((err) => {
          console.error(`Error creating password for user ${user.id}:`, err);
          throw new Error(`Could not create password for user ${user.id}`);
        });
        console.log(`created new password for ${user.id}`);

        //create a new account
        const account = await this.accountShape
          .create({
            accountOf: user,
            email: normalizedEmail,
          })
          .catch((err) => {
            console.error(`Error creating account for user ${user.id}:`, err);
            throw new Error(`Could not create account for user ${user.id}`);
          });

        console.log(`new user ${user.id}, account ${account.id}`);

        return {
          account: account,
          person: user,
        };
      },
      'createAccount'
    );

    // the sign-in result is the same whether or not the email went out
    if (!('error' in result)) {
      await sendVerificationEmail(
        normalizedEmail,
        firstName,
        verificationToken,
        verificationFields.emailVerificationToken
      );
    }
    return result;
  }

  /**
   * Get the password (AuthCredential) for a user
   *
   * @param user - The user
   * @returns The password (AuthCredential)
   */
  async getPasswordForUser(user: QResult<Person>) {
    const credentials = await AuthCredential.select((cred) => {
      return [
        cred.passwordHash,
        cred.credentialOf.select((p) => {
          return [p.givenName, p.familyName, p.telephone];
        }),
      ];
    }).where((cred) => {
      return cred.credentialOf.equals({ id: user.id });
    });
    // OAuth sign-in and older releases can leave several credential rows on one person, some
    // without a password hash. The one with a hash is the password.
    const credential = preferCredentialWithPassword(credentials);

    if (!credential) {
      console.warn(`Could not find any password for account ${user.id}`);
      return null;
    }

    return credential;
  }
  /**
   * Reset the password (with a token from the reset email), or change it (signed in).
   *
   * With a token (from a link sent by `sendResetPasswordLink`), the token is used up by this
   * call: it works once, and only until it expires (`AUTH_PASSWORD_RESET_TTL`).
   *
   * Without a token the signed-in user's password is changed, and `currentPassword` must be
   * their current password. An account that has no password yet (e.g. OAuth only) cannot get
   * one this way: it gets one through the reset email, and is told so (`action:
   * 'reset_password_by_email'`).
   *
   * Either way any outstanding reset link stops working.
   *
   * @param password - The new password
   * @param confirmPassword - The confirmed password
   * @param token - The reset password token, if any
   * @param currentPassword - The current password; required when there is no token
   * @returns
   */
  async resetPassword(
    password: string,
    confirmPassword: string,
    token?: string,
    currentPassword?: string
  ): Promise<AuthenticationResult> {
    // A token is guessed by address only; a signed-in change also checks the current password,
    // so it is limited per account as well.
    const limited = token
      ? await limitRequest('passwordReset', this.request, this.response)
      : await limitRequest(
          'passwordChange',
          this.request,
          this.response,
          this.request?.linkedAuth?.userAccount?.id ?? this.request?.linkedAuth?.user?.id
        );
    if (limited) return limited;

    // check if password and confirmPassword match
    if (password !== confirmPassword) {
      return {
        error: 'Passwords do not match',
      };
    }
    // checked before a token is used up, like the match above
    if (!isAcceptablePassword(password)) {
      return { ...INVALID_PASSWORD_RESULT };
    }

    //reset password works both if a token is provided, and if a user is currently logged in
    // A token is used up here, before anything else can fail: a link must never work twice.
    const user: QResult<Person> | undefined = token
      ? await PasswordHelper.consumeResetPasswordToken(token)
      : this.request?.linkedAuth?.user;

    if (!user) {
      console.warn('No user account found to reset password');
      return {
        error: 'No user account found to reset password',
      };
    }

    // get the password from the database
    const dbPassword = await this.getPasswordForUser(user);

    // Without a token, this is a signed-in change: it needs the current password, so a session
    // alone (an unattended device, a stolen access token) cannot take over the account.
    if (!token) {
      if (!dbPassword?.passwordHash) {
        return {
          error:
            'This account has no password yet. Use the reset password email to set one.',
          action: 'reset_password_by_email',
        };
      }
      if (!currentPassword || typeof currentPassword !== 'string') {
        return {
          error: 'Your current password is required to change your password',
        };
      }
      const currentIsValid = await PasswordHelper.checkPassword(
        currentPassword,
        dbPassword.passwordHash
      );
      if (!currentIsValid) {
        return {
          error: 'Your current password is incorrect',
        };
      }
    }

    //find or create the account of the user
    const account = await this.getOrCreateAccount(user);

    // Phase 1.1: WebID is one-way (UUID v5 of email). Recover email by
    // looking up UserAccount.email keyed on the WebID rather than reversing.
    const emailLookup = await UserAccount.select((ua) => [ua.email])
      .where((ua) => ua.accountOf.equals({ id: user.id } as any))
      .one()
      .catch(() => null);
    const email = (emailLookup as any)?.email ?? null;

    if (!email) {
      console.warn(
        `Could not look up email for webID during password reset: ${user.id}`
      );
      return {
        error: 'Could not determine email address from user account',
      };
    }

    // if no password found, create a new one (only reachable with a valid reset token)
    if (!dbPassword) {
      console.warn(
        'Password not found for this account : ' +
          user.id +
          'creating one in order to reset password'
      );
      await AuthCredential.createNewCredential(email, password, user);
    } else {
      // update existing password
      const newHashedPassword = await PasswordHelper.generateHashedPassword(
        password
      );

      // a new password also ends any reset link still outstanding for it
      await AuthCredential.update({
        passwordHash: newHashedPassword,
        ...PasswordHelper.clearedResetPasswordTokenFields(),
      }).for(dbPassword);
    }

    // The reset link was opened from the inbox, which proves the email as well.
    if (token) {
      await markEmailVerified(user.id, email).catch((error) =>
        console.error('Could not mark the email verified after a password reset', error)
      );
    }

    // A new password ends every existing session (other devices, and anyone holding a stolen
    // refresh token). The current device gets a fresh session below.
    await revokeAllSessionsForAccount(account.id);

    const person = user;
    return Auth.onSigninSuccessful(this, person, account);
  }

  async getOrCreateAccount(user: QResult<Person>) {
    //get or create account
    let account = await this.accountShape
      .select((a) => a.accountOf)
      .where((a) => a.accountOf.equals({ id: user.id }))
      .one();
    if (!account) {
      //accounts can be created on the fly,
      // it means this user/webID existed, but it's the first time they log in here to this app
      // use account.profileSetupComplete or similar if you want to direct the user to a profile setup page
      account = await this.accountShape.create({
        accountOf: {
          id: user.id,
        },
      });
    }
    return account;
  }

  /**
   * Send a reset password link to `email`, through the registered email provider.
   *
   * Answers `true` for every well-formed email, whether or not an account exists for it and
   * whether or not the email could be sent, so the answer never tells which emails have an
   * account. When the email is not sent, the stored token is removed again.
   *
   * @param email - The email address
   * @returns true, or an error for a malformed email or a rate-limited request
   */
  async sendResetPasswordLink(email: string) {
    // every request sends an email; counted by the address asked for, existing or not
    const limited = await limitRequest(
      'passwordResetRequest',
      this.request,
      this.response,
      email
    );
    if (limited) return limited;

    const newToken = PasswordHelper.generateToken();
    // Only the hash is stored, with an expiry. Writing it replaces any earlier link's token.
    const resetTokenFields = PasswordHelper.resetPasswordTokenFields(newToken);
    const normalizedEmail = email.toLowerCase();
    let webID: string;
    try {
      webID = Auth.webIdFor(normalizedEmail);
    } catch (error) {
      console.error('Invalid email format during password reset request');
      return {
        error: 'Invalid email format',
      };
    }

    const existingCredential = await this.getPasswordForUser({ id: webID });

    if (!existingCredential) {
      const account = await UserAccount.select((ua) => {
        return [
          ua.email,
          ua.accountOf.select((p) => {
            return [p.givenName, p.telephone];
          }),
        ];
      })
        .where((ua) => {
          return ua.email.equals(normalizedEmail);
        })
        .one();

      if (!account?.accountOf?.id) {
        console.warn('No account found for a reset password request');
        return true;
      }

      webID = account.accountOf.id;
      await AuthCredential.create({
        credentialOf: {
          id: webID,
        },
        email: normalizedEmail,
        telephone: account.accountOf.telephone || undefined,
        ...resetTokenFields,
      });
    } else {
      await AuthCredential.update(resetTokenFields).for(existingCredential);
    }

    const person = await this.userShape
      .select((u) => u.givenName)
      .for({ id: webID })
      .one();

    if (!person) {
      console.warn('No user found for a reset password request');
      await clearUnsentToken('reset', resetTokenFields.forgotPasswordToken);
      return true;
    }

    const confirmUrl = `${process.env.SITE_ROOT}/auth/reset-password?token=${newToken}`;

    const emailOptions = {
      to: [
        {
          email_address: {
            address: email, // destination
            name: normalizedEmail, // recipient Name
          },
        },
      ],
      subject: `Reset Your ${process.env.APP_NAME} Password`,
      htmlbody: `
          <table role='presentation' border='0' cellpadding='0' cellspacing='0' class='body' style='border-collapse: separate; mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #fff; width: 100%;' width='100%' bgcolor='#fff'>
            <tr>
              <td>
                <p>Hey ${escapeHtml(person.givenName)} 👋</p>
                <p>Click the button below to reset your password:</p>
                <a href='${escapeHtml(confirmUrl)}' target='_blank' style='border: solid 1px #3498db; border-radius: 5px; box-sizing: border-box; cursor: pointer; display: inline-block; font-size: 14px; font-weight: bold; margin: 0; padding: 12px 25px; text-decoration: none; text-transform: capitalize; background-color: #3498db; border-color: #3498db; color: #ffffff;'>Reset Password</a>
                <p>Cheers,</p>
                <p>${escapeHtml(process.env.APP_NAME)} Team</p>
              </td>
            </tr>
            <tr>
              <td>
                <p style='font-size: 12px; color: #999;'>Alternatively, you can also copy and paste the link into your browser:</p>
                <a href='${escapeHtml(confirmUrl)}' target='_blank' style='font-size: 12px;'>${escapeHtml(confirmUrl)}</a>
              </td>
            </tr>
          </table>
        `,
    };

    const outcome = await sendAuthEmail(emailOptions, { purpose: 'reset', url: confirmUrl });
    if (outcome === 'failed') {
      await clearUnsentToken('reset', resetTokenFields.forgotPasswordToken);
    }
    return true;
  }

  /**
   * Email a sign-in code to `email`: an eight-digit code and a link that carries it
   * (`{SITE_ROOT}/auth/signin-code?email=…&code=…`), for `signinWithCode`. The code works once,
   * until it expires (`AUTH_SIGNIN_CODE_TTL`), and a new request replaces it. An email with no
   * account gets a code too, held by a pending credential: signing in with it reaches the person
   * that has the email by then, or creates one.
   *
   * Answers `true` for every well-formed email, whether or not an account exists for it and
   * whether or not the email could be sent, so the answer never tells which emails have an
   * account. When the email is not sent, the stored code is removed again. With DEV_AUTH on and
   * no email provider, the code and link go to the server log.
   *
   * @param email - The email address
   * @returns true, or an error for a malformed email or a rate-limited request
   */
  async sendSigninCode(email: string) {
    // every request sends an email; counted by the address asked for, existing or not
    const limited = await limitRequest('signinCodeRequest', this.request, this.response, email);
    if (limited) return limited;

    if (typeof email !== 'string') return { error: 'Invalid email format' };
    const normalizedEmail = normalizeSigninEmail(email);
    let webID: string;
    try {
      webID = Auth.webIdFor(normalizedEmail);
    } catch (error) {
      console.error('Invalid email format during a sign-in code request');
      return { error: 'Invalid email format' };
    }

    const code = generateSigninCode();
    // only the hash of the email and code is stored, with an expiry
    const fields = signinCodeFields(normalizedEmail, code);
    const personId = await storeSigninCode(this, normalizedEmail, webID, fields);

    const signinUrl =
      `${process.env.SITE_ROOT}/auth/signin-code` +
      `?email=${encodeURIComponent(normalizedEmail)}&code=${code}`;
    const givenName = personId ? await givenNameOf(this, personId) : undefined;
    const outcome = await sendAuthEmail(
      signinCodeMessage(normalizedEmail, givenName, code, signinUrl),
      { purpose: 'signin-code', url: signinUrl, code }
    );
    if (outcome === 'failed') {
      await clearUnsentToken('signinCode', fields.signinCode);
    }
    return true;
  }

  /**
   * Sign in with a code from `sendSigninCode`, typed in or carried by its link. The code works
   * once, until it expires, and only with the email it was sent to; every other code is refused
   * with the same answer. Signing in proves control of the email, so it is marked verified. An
   * email without an account gets one: the person at the WebID `Auth.webIdFor` derives from it,
   * and its account.
   *
   * @param email - The email the code was sent to
   * @param code - The code (spaces and dashes are ignored)
   */
  async signinWithCode(email: string, code: string): Promise<AuthenticationResult> {
    // before anything is looked up; by the email, so a code cannot be guessed from many addresses
    const limited = await limitRequest('signinCode', this.request, this.response, email);
    if (limited) return limited;

    const refused = { error: INVALID_SIGNIN_CODE_MESSAGE, action: 'invalid_code' };
    if (typeof email !== 'string' || !normalizeSigninCode(code)) return refused;
    const normalizedEmail = normalizeSigninEmail(email);
    let webID: string;
    try {
      webID = Auth.webIdFor(normalizedEmail);
    } catch (error) {
      return refused;
    }

    const consumed = await consumeCredentialTokenRecord(
      'signinCode',
      signinCodeSecret(normalizedEmail, code)
    );
    if (!consumed) return refused;

    let personId = consumed.person?.id;
    if (!personId) {
      // A pending credential held the code: the email had no person when it was sent. One may
      // exist by now (a signup, an OAuth sign-in), found as `storeSigninCode` finds it; else the
      // person is created at the WebID. The credential becomes that person's.
      const atWebID = await this.userShape.select((p) => [p.givenName]).for(webID);
      personId = atWebID ? webID : ((await personOfAccountEmail(normalizedEmail)) ?? webID);
      await AuthCredential.update({
        credentialOf: { id: personId },
        email: normalizedEmail,
        signinCodeEmailHash: null,
      }).for({ id: consumed.credentialId });
    }

    const person = await this.userShape.select((p) => [p.givenName]).for(personId);
    if (person) {
      await markEmailVerified(personId, normalizedEmail);
      const account = await this.getOrCreateAccount({ id: personId });
      return Auth.onSigninSuccessful(this, { id: personId } as UserData, account as UserAccountData);
    }

    return Auth.login(
      this,
      async () => null,
      async () => {
        const user = await (this.userShape as any)
          .create({ __id: personId, givenName: '', familyName: '', telephone: '' })
          .catch((err) => {
            console.error(`Error creating user ${personId}:`, err);
            throw new Error(`Could not create user ${personId}`);
          });
        await markEmailVerified(user.id, normalizedEmail);
        const account = await this.accountShape
          .create({ accountOf: user, email: normalizedEmail })
          .catch((err) => {
            console.error(`Error creating account for user ${user.id}:`, err);
            throw new Error(`Could not create account for user ${user.id}`);
          });
        console.log(`new user ${user.id} from a sign-in code, account ${account.id}`);
        return { account, person: user };
      },
      'signinWithCode'
    );
  }

  /**
   * Sign in with an OAuth provider.
   *
   * Only providers whose credential this server verifies itself are accepted (see
   * VERIFIED_OAUTH_PROVIDERS). The account is then found from what the provider vouches for,
   * never from what the client sent:
   *
   * 1. an identity linked to an account (provider + subject) signs straight in;
   * 2. otherwise an existing account with the verified email is attached only when
   *    `decideEmailMatchedAccount` allows it. When it does not, sign-in fails with
   *    `action: 'sign_in_to_link'`: the user signs in the way they did before and connects the
   *    provider with `linkOAuthIdentity`;
   * 3. otherwise a new account is created, without a password.
   *
   * Every sign-in that reaches an account leaves a link behind, so the email is consulted only
   * once per identity.
   *
   * @param provider - The OAuth provider
   * @param oauthUserData - The provider's credential (Google: `authentication.idToken`, Apple:
   *   `identityToken` and the `nonce` from `createOAuthNonce`, see AUTH_APPLE_NONCE), plus for
   *   Apple the name the client received on first consent
   */
  async signinOAuth(
    provider: OAuthProvider,
    oauthUserData: any
  ): Promise<AuthenticationResult> {
    const limited = await limitRequest('oauth', this.request, this.response);
    if (limited) return limited;

    if (!VERIFIED_OAUTH_PROVIDERS.includes(provider)) {
      console.error(
        `signinOAuth: rejected provider ${JSON.stringify(provider)}, ` +
          `only ${VERIFIED_OAUTH_PROVIDERS.join(', ')} can be verified`
      );
      return { error: 'Unsupported OAuth provider' };
    }

    const identity = await verifyOAuthIdentity(provider, oauthUserData || {});
    if ('error' in identity) return identity;

    let links: OAuthIdentityLink[];
    try {
      links = await OAuthIdentityStore.findLinks(provider, identity.subject);
    } catch (error) {
      console.error(`${provider} sign-in: could not look up linked identities`, error);
      return { error: 'Sign-in is temporarily unavailable. Please try again.' };
    }

    const linkedAccountIds = [...new Set(links.map((link) => link.accountId))];
    if (linkedAccountIds.length > 1) {
      console.error(`${provider} sign-in: one identity is linked to several accounts`);
      return {
        error: 'This sign-in is linked to more than one account. Please contact support.',
      };
    }
    if (linkedAccountIds.length === 1) {
      const account = await loadAccountWithPerson(this, linkedAccountIds[0]);
      if (account?.accountOf?.id) {
        for (const link of links.filter((l) => l.legacy)) {
          await OAuthIdentityStore.upgradeLegacyLink(link, provider).catch((err) =>
            console.warn(`${provider} sign-in: could not upgrade a legacy identity link`, err)
          );
        }
        await markOAuthEmailVerified(identity, account.accountOf.id);
        return Auth.onSigninSuccessful(this, account.accountOf as UserData, account);
      }
      // a link to an account that no longer exists: fall through to the email
    }

    if (!identity.email || !identity.emailVerified) {
      console.log(`signinOAuth: no verified email from ${provider}`);
      return { error: 'could not find email in OAuth response' };
    }
    const email = identity.email.trim().toLowerCase();
    let webID: string;
    try {
      webID = Auth.webIdFor(email);
    } catch (error) {
      console.error('Invalid email format during OAuth signin');
      return { error: 'Invalid email format' };
    }

    const existing = await findAccountForOAuthEmail(this, webID, identity.email, email);
    if (existing.conflict) {
      console.error(`${provider} sign-in: verified email matches several accounts or people`);
      return {
        error: 'This email is associated with more than one account. Please contact support.',
        action: 'account_conflict',
      };
    }
    if (existing.personId) {
      const decision = decideEmailMatchedAccount({
        provider,
        emailVerified: identity.emailVerified,
        existing: {
          hasPassword: await OAuthIdentityStore.personHasPassword(existing.personId),
          linkedProviders: existing.account
            ? await OAuthIdentityStore.findLinkedProviders(existing.account.id)
            : [],
        },
      });
      if ('error' in decision) return decision;

      const person = { id: existing.personId } as UserData;
      const account =
        existing.account ?? ((await this.getOrCreateAccount(person)) as UserAccountData);
      await OAuthIdentityStore.createLink(identity, account.id);
      await markOAuthEmailVerified(identity, existing.personId);
      return Auth.onSigninSuccessful(
        this,
        (existing.account?.accountOf as UserData) ?? person,
        account
      );
    }

    // a new user: create the person, an OAuth credential (no password) and the account
    return Auth.login(
      this,
      async () => null,
      async () => {
        const user = await (this.userShape as any)
          .create({
            __id: webID,
            givenName: identity.givenName || '',
            familyName: identity.familyName || '',
            telephone: '',
          })
          .catch((err) => {
            console.error(`Error creating ${provider} user ${webID}:`, err);
            throw new Error(`Could not create ${provider} user ${webID}`);
          });

        // A credential without a password hash: it carries the email for password reset. The
        // provider verified that email.
        await AuthCredential.create({
          credentialOf: {
            id: user.id,
          },
          email: email,
          emailVerifiedAt: new Date(),
        }).catch((err) => {
          console.error(`Error creating credential for ${provider} user ${user.id}:`, err);
          throw new Error(`Could not create credential for ${provider} user ${user.id}`);
        });

        const account = await this.accountShape
          .create({
            accountOf: user,
            email: email,
          } as any)
          .catch((err) => {
            console.error(`Error creating ${provider} account for user ${user.id}:`, err);
            throw new Error(`Could not create ${provider} account for user ${user.id}`);
          });

        await OAuthIdentityStore.createLink(identity, account.id).catch((err) => {
          console.error(`Error linking the ${provider} identity of user ${user.id}:`, err);
          throw new Error(`Could not link the ${provider} identity of user ${user.id}`);
        });

        console.log(`${provider} user ${user.id} created, account ${account.id}`);

        return {
          account: account as any,
          person: user as any,
        };
      },
      `${provider} OAuth`
    );
  }

  /**
   * Verify the email of an account with the token from a link sent by `createAccount` or
   * `resendEmailVerification`. The token works once, and only until it expires
   * (`AUTH_EMAIL_VERIFICATION_TTL`). Needs no session and signs no one in: a signed-in client
   * refreshes its session afterwards to see `emailVerified`.
   *
   * @param token - The token from the link
   */
  async verifyEmail(token: string): Promise<VerifyEmailResult> {
    const limited = await limitRequest('emailVerify', this.request, this.response);
    if (limited) return limited;

    const person = await consumeCredentialToken('verify', token);
    if (!person?.id) {
      return {
        error: 'This verification link is invalid or has expired.',
        action: 'resend_verification',
      };
    }
    await markEmailVerified(person.id);
    return { verified: true };
  }

  /**
   * Send the signed-in account a new email verification link, to the account's email. The new
   * link replaces any earlier one. An account that is already verified gets no email
   * (`{verified: true}`), and one without an email (a temporary account) gets `action:
   * 'no_email'`.
   */
  async resendEmailVerification(): Promise<ResendEmailVerificationResult> {
    const account: UserAccountData = requireSessionUser();
    const limited = await limitRequest(
      'emailVerificationRequest',
      this.request,
      this.response,
      account.id
    );
    if (limited) return limited;

    const personId: string | undefined =
      this.request?.linkedAuth?.user?.id ?? account.accountOf?.id;
    if (!personId) {
      throw new Error('Cannot send a verification email: the session has no person');
    }
    if (await personEmailVerified(personId)) {
      return { verified: true };
    }

    const email = (await accountEmail(this, account)).trim().toLowerCase();
    if (!email) {
      return { error: 'This account has no email address.', action: 'no_email' };
    }

    const token = PasswordHelper.generateToken();
    const fields = verificationTokenFields(token);
    const credential = preferCredentialWithPassword(
      await AuthCredential.select((cred) => [cred.passwordHash]).where((cred) =>
        cred.credentialOf.equals({ id: personId })
      )
    );
    if (credential) {
      await AuthCredential.update(fields).for({ id: credential.id });
    } else {
      await AuthCredential.create({ credentialOf: { id: personId }, email, ...fields });
    }

    const sent = await sendVerificationEmail(
      email,
      await givenNameOf(this, personId),
      token,
      fields.emailVerificationToken
    );
    if (!sent) {
      return {
        error: "Sorry, we couldn't send the email, please try again later",
        action: 'email_failed',
      };
    }
    return { sent: true };
  }

  /**
   * Issue a sign-in nonce. The client hands it (or its SHA-256, hex) to the provider, e.g. as
   * the `nonce` of Sign in with Apple, and sends the raw nonce back with the identity token as
   * `nonce`. Each nonce works for one sign-in, within `AUTH_OAUTH_NONCE_TTL` seconds (default
   * 600). Issuing stores nothing.
   */
  async createOAuthNonce(): Promise<{ nonce: string; expiresAt: string }> {
    const { nonce, expiresAt } = issueOAuthNonce();
    return { nonce, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Connect a provider identity to the account that is signed in now.
   *
   * This is the proven way to attach a provider to an existing account: the session proves
   * ownership of the account, and the verified credential proves ownership of the provider
   * identity. `signinOAuth` refuses to attach by email on its own (`action: 'sign_in_to_link'`)
   * and points here.
   *
   * @param provider - The OAuth provider
   * @param oauthUserData - The provider's credential, as for `signinOAuth`
   */
  async linkOAuthIdentity(
    provider: OAuthProvider,
    oauthUserData: any
  ): Promise<LinkOAuthIdentityResult> {
    const account = (this.request?.linkedAuth as AuthSession | undefined)?.userAccount;
    if (!account?.id) {
      return { error: 'Sign in first to connect a sign-in method.' };
    }
    const limited = await limitRequest('oauth', this.request, this.response, account.id);
    if (limited) return limited;
    if (!VERIFIED_OAUTH_PROVIDERS.includes(provider)) {
      return { error: 'Unsupported OAuth provider' };
    }

    const identity = await verifyOAuthIdentity(provider, oauthUserData || {});
    if ('error' in identity) return identity;

    const links = await OAuthIdentityStore.findLinks(provider, identity.subject);
    const linkedAccountIds = new Set(links.map((link) => link.accountId));
    if (linkedAccountIds.size === 1 && linkedAccountIds.has(account.id)) {
      return { linked: true };
    }
    if (linkedAccountIds.size > 0) {
      return { error: `This ${provider} account is already connected to another account.` };
    }
    if ((await OAuthIdentityStore.findLinkedProviders(account.id)).includes(provider)) {
      return {
        error: `This account is already connected to a different ${provider} account.`,
      };
    }

    await OAuthIdentityStore.createLink(identity, account.id);
    return { linked: true };
  }

  /**
   * Temporary sign in without any credentials
   * TODO: how to make this support with WebID? since user doesn't have email
   *
   * Note: we not save AuthCredential for temporary user for now, you need to save it on different way. Example: on register form, etc..
   *
   * @returns
   */
  async signinTemporary() {
    const limited = await limitRequest('temporarySignin', this.request, this.response);
    if (limited) return limited;

    const person = await (this.userShape as any)
      .create({
        givenName: '',
      })
      .catch((err) => {
        console.error('Error creating temporary user:', err);
        throw new Error('Error creating temporary user');
      });
    console.log(`Temporary person created: ${person.id}`);

    const account = await this.accountShape
      .create({
        accountOf: person,
      })
      .catch((err) => {
        console.error('Error creating temporary account:', err);
        throw new Error('Error creating temporary account');
      });
    console.log(`Temporary account created: ${account.id}`);

    account.accountOf = person;

    return await Auth.onSigninSuccessful(
      this,
      person,
      account as UserAccountData,
      true
    );
  }

  /**
   * Dev-mode webid.email sign-in. Counterpart of GET /auth/dev:
   * the iframe loaded from /auth/dev posts {webId, accessToken, refreshToken}
   * to the parent. The frontend forwards that payload here via Server.call.
   *
   * We trust the access token because we signed it ourselves moments ago
   * (DEV_AUTH=true path only — Phase 5.3 swaps in webid.email's JWT).
   *
   * After validating, find or create the Person + UserAccount, then return
   * the standard signin response shape. Workspace provisioning is done by
   * the frontend in a follow-up Server.call to avoid coupling @_linked/auth
   * to CN-specific shapes.
   */
  async signinDev(input: {
    webId: string;
    accessToken: string;
    refreshToken: string;
    /** Ignored: the email comes from the verified token. Kept so existing callers still type-check. */
    email?: string;
  }) {
    // DEV_AUTH gate — tolerate either string 'true' or boolean true.
    // (env-cmd's spread-assign to process.env preserves boolean values.)
    const devAuth = process.env.DEV_AUTH as unknown;
    if (devAuth !== 'true' && devAuth !== true) {
      return { error: 'Dev signin disabled' };
    }
    const tokenResult = await verifyToken({
      request: this.request,
      token: input.accessToken,
      refreshToken: input.refreshToken,
      provider: this,
    });
    if (!tokenResult || (tokenResult as any).error) {
      return { error: (tokenResult as any)?.error ?? 'Invalid token' };
    }
    const claims = (tokenResult as any).payload ?? tokenResult;
    // a token must name its subject: one without `sub` could otherwise sign in as any WebID
    if (!claims.sub) {
      return { error: 'Invalid token' };
    }
    if (claims.sub !== input.webId) {
      return { error: 'WebID does not match token subject' };
    }
    // Only the verified token's email claim; `input.email` is the client's word and never stored.
    const email = claims.email as string | undefined;

    // Dev signin doesn't persist a Person — the WebID profile is hosted by the
    // identity provider (e.g. webid.email). Plain identity data, never a live Shape.
    const person = { id: input.webId } as UserData;

    // Find or create the UserAccount for this Person/WebID.
    const account = await this.getOrCreateAccount(person);
    if (email && !(account as any).email) {
      try {
        await (this.accountShape as any).update({ email }).for(account);
      } catch (err) {
        console.warn('Could not set email on UserAccount:', err);
      }
    }

    return Auth.onSigninSuccessful(this, person, account as UserAccountData);
  }

  /**
   * What the signed-in account confirms an account deletion with (see `removeAccount`):
   * `['password']`, its linked providers (`'google'`, `'apple'`), or none (temporary and dev
   * accounts, which a session alone may delete).
   */
  async getReauthenticationMethods(): Promise<{ methods: ReauthenticationMethod[] }> {
    const account: UserAccountData = requireSessionUser();
    const personId: string | undefined =
      this.request?.linkedAuth?.user?.id ?? account.accountOf?.id;
    if (!personId) {
      throw new Error('Cannot list confirmation methods: the session has no person');
    }
    return { methods: await reauthenticationMethods(account.id, personId) };
  }

  /**
   * Delete the signed-in account, its person, credentials, identity links and sessions.
   *
   * An account with a password or a linked Google/Apple identity must confirm it is the account
   * holder in the same call: `{password}`, or `{provider, source}` with a freshly issued ID token
   * (`source` as for `signinOAuth`). A missing or wrong proof answers `action: 'reauthenticate'`
   * with the `methods` the account can use (also given by `getReauthenticationMethods`).
   * Checking a proof is rate-limited (`reauthenticate`).
   *
   * @param proof - The password, or the provider credential
   */
  async removeAccount(proof?: RemoveAccountProof): Promise<RemoveAccountResult> {
    const account: UserAccountData = requireSessionUser();
    const personId: string | undefined =
      this.request?.linkedAuth?.user?.id ?? account.accountOf?.id;
    if (!account.id || !personId) {
      throw new Error('Cannot remove account: the session has no account or user id');
    }

    const methods = await reauthenticationMethods(account.id, personId);
    if (methods.length) {
      if (!hasReauthenticationProof(proof)) {
        return { error: REAUTH_MISSING_MESSAGE, action: 'reauthenticate', methods };
      }
      const limited = await limitRequest(
        'reauthenticate',
        this.request,
        this.response,
        account.id
      );
      if (limited) return limited;
      if (!(await verifyReauthentication(this, account.id, personId, proof))) {
        return { error: REAUTH_MISMATCH_MESSAGE, action: 'reauthenticate', methods };
      }
    }

    await emitAccountWillBeRemovedEvent(account);
    await deleteAllSessionsForAccount(account.id);

    // Delete every credential of the person and every identity token of the account BEFORE the
    // person and account: deleting those also removes the links pointing at them, which would
    // leave these nodes unreachable but still holding the email, password hashes and subject.
    await AuthCredential.deleteWhere((credential) =>
      credential.credentialOf.equals({ id: personId })
    );
    await IdentityToken.deleteWhere((token) =>
      token.account.equals({ id: account.id })
    );

    //remove account and user
    await this.accountShape.delete({ id: account.id });
    await this.userShape.delete({ id: personId });

    console.log('Account has been deleted', account.id);
    await this.signout();

    return true;
  }

  /**
   * Sign out: revoke the current session, so its refresh token can no longer be used, and clear
   * the auth cookies.
   *
   * The session is taken from the access token (`sid`) and/or from the refresh token the client
   * passes (native clients) or sends as the `refreshToken` cookie. The access token itself stays
   * valid until it expires (at most AUTH_ACCESS_TOKEN_TTL).
   *
   * @param refreshToken - Optional refresh token of the session to end
   * @returns true if the user was signed in or a session was revoked
   */
  async signout(refreshToken?: string): Promise<boolean> {
    const request = this.request;
    const response = this.response;
    try {
      const auth: any = request?.linkedAuth;
      refreshToken = refreshToken || this.getRefreshTokenFromRequest(request);

      const sessionIds = new Set<string>();
      if (auth?.sid) {
        sessionIds.add(auth.sid);
      }
      if (refreshToken) {
        const sessionId = await findSessionIdForRefreshToken(refreshToken);
        if (sessionId) sessionIds.add(sessionId);
      }

      let revoked = 0;
      for (const sessionId of sessionIds) {
        revoked += await revokeSession(sessionId);
      }
      return Boolean(auth) || revoked > 0;
    } catch (err) {
      console.warn('error during signout: ', err.toString());
      throw err;
    } finally {
      // whatever happened to the session, this browser is signed out
      clearAuthCookies(request, response);
    }
  }

  /**
   * Validate the client's tokens and return the authentication result. This is also where the
   * client refreshes: the response sets new cookies and carries the new access token.
   *
   * - A valid access token (and no `forceRefresh`): returned as is.
   * - Otherwise, with a refresh token (the httpOnly `refreshToken` cookie, or the argument from a
   *   native client): the refresh token is exchanged (see utils/sessions.ts) for a new access
   *   token and, normally, a new refresh token. The old refresh token is then dead.
   * - A refresh that fails clears the auth cookies.
   *
   * @param refreshToken - Optional refresh token (native clients; browsers send the cookie)
   * @param options.forceRefresh - refresh even if the access token is still valid (the client's
   *   scheduler does this shortly before `exp`)
   * @returns A promise that resolves to an authentication result
   */
  async validateToken(
    refreshToken?: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<AuthenticationResult> {
    const request = this.request;
    const response = this.response;
    refreshToken = refreshToken || this.getRefreshTokenFromRequest(request);
    const candidates = this.getTokenCandidates(request);

    if (candidates.length === 0 && !refreshToken) {
      // no token found in Authorization header or cookies
      return {
        error: 'No token found',
      };
    }

    try {
      let token: string | undefined;
      let payload: ReturnType<typeof verifyAccessToken> = false;
      for (const candidate of candidates) {
        payload = verifyAccessToken(candidate);
        if (payload) {
          token = candidate;
          break;
        }
      }
      if (payload && !(options?.forceRefresh && refreshToken)) {
        const authentication = Auth.setAuthentication(request, payload);
        // Tell the client how long the server honours its refresh token.
        const refreshTokenExpiresAt = refreshToken
          ? await findRefreshTokenExpiry(refreshToken)
          : undefined;
        // Re-set the access cookie when the browser does not hold this token as an httpOnly
        // cookie yet (it came from the header, or from a cookie written by an older client).
        const cookieIsCurrent = (request as any)?.cookies?.accessToken === token;
        return deliverTokens(
          request,
          cookieIsCurrent ? false : response,
          {
            auth: authentication,
            accessToken: token,
            refreshToken,
            ...refreshTokenExpiryFields(refreshTokenExpiresAt),
          },
          { newRefreshToken: false }
        );
      }

      if (refreshToken) {
        // only an exchange is counted: it writes to the store, a valid access token does not
        const limited = await limitRequest('tokenRefresh', request, response);
        if (limited) return limited;
        return await this.refreshSession(refreshToken);
      }

      return {
        error: 'Invalid token',
      };
    } catch (err) {
      console.error('@_linked/auth: token validation failed', err);
      return {
        error: 'Token decoding error',
      };
    }
  }

  /**
   * Exchange a refresh token for a new access token (and a new refresh token).
   * The user and account are reloaded, and the app's providers can extend the session again
   * (`initialAuthSession` / `extendAuthSession`), exactly as at sign-in.
   */
  protected async refreshSession(
    refreshToken: string
  ): Promise<AuthenticationResult> {
    const request = this.request;
    const response = this.response;
    const rotation = await rotateRefreshToken(refreshToken);
    if (rotation.ok === false) {
      clearAuthCookies(request, response);
      return {
        error: 'Invalid refresh token',
      };
    }

    const account = await this.loadAccountForSession(rotation.accountId);
    if (!account) {
      // the account is gone; nothing may be refreshed for it any more
      await revokeSession(rotation.sessionId);
      clearAuthCookies(request, response);
      return {
        error: 'Invalid refresh token',
      };
    }
    const person = await this.loadUserForSession(account);

    const authentication = await Auth.buildAuthSession(this, person, account);
    const accessToken = await createAccessToken(
      authentication,
      undefined,
      rotation.sessionId
    );
    const linkedAuth = Auth.setAuthentication(request, {
      ...authentication,
      sid: rotation.sessionId,
    });

    return deliverTokens(
      request,
      response,
      {
        auth: linkedAuth,
        accessToken,
        refreshToken: rotation.refreshToken,
        ...refreshTokenExpiryFields(rotation.refreshTokenExpiresAt),
      },
      { refreshTokenExpiresAt: rotation.refreshTokenExpiresAt }
    );
  }

  /** The account a refresh token was issued to, with the fields a sign-in provides. */
  protected async loadAccountForSession(
    accountId: string
  ): Promise<UserAccountData | null> {
    const account: any = await (this.accountShape as any)
      .select((a) => [a.email, a.accountOf])
      .for({ id: accountId });
    if (!account || !account.accountOf) {
      return null;
    }
    return account as UserAccountData;
  }

  /**
   * The person behind an account. Not every person is stored locally (a WebID can be hosted by
   * the identity provider), so this falls back to the bare id.
   */
  protected async loadUserForSession(
    account: UserAccountData
  ): Promise<UserData> {
    const id = (account.accountOf as any)?.id;
    try {
      const person = await (this.userShape as any)
        .select((p) => [p.givenName, p.familyName, p.telephone])
        .for({ id });
      if (person) return person as UserData;
    } catch (err) {
      console.warn(`@_linked/auth: could not load person ${id} for refresh`, err);
    }
    return { id } as UserData;
  }

  /**
   * Gets the access token from the request: the Bearer header, else the `accessToken` cookie.
   * @protected
   */
  protected getTokenFromRequest(req: Request) {
    return this.getTokenCandidates(req)[0] ?? null;
  }

  /**
   * The access tokens a request carries, in the order they are tried: the Bearer header first,
   * then the `accessToken` cookie. Both are tried because a browser tab may hold a stale token in
   * memory (sent as the header) while the httpOnly cookie was already renewed by another tab.
   * @protected
   */
  protected getTokenCandidates(req: Request): string[] {
    const tokens: string[] = [];
    const header = req?.headers?.authorization;
    if (header && header.split(' ')[0] === 'Bearer' && header.split(' ')[1]) {
      tokens.push(header.split(' ')[1]);
    }
    const cookie = (req as any)?.cookies?.accessToken;
    if (cookie && !tokens.includes(cookie)) {
      tokens.push(cookie);
    }
    return tokens;
  }

  // get refresh token from request (the httpOnly cookie)
  protected getRefreshTokenFromRequest(req: Request) {
    return (req as any)?.cookies && (req as any).cookies.refreshToken;
  }
}

/**
 * The RPC surface of this provider: which methods `/call/@_linked/auth/<method>` may reach. A
 * server running `rpcExposure: 'enforce'` refuses (501) any method not declared here, so every
 * method this provider defines is declared one way or the other (test/exposure.test.mjs fails on
 * one that is not).
 *
 * Callable (what auth's own frontend calls):
 * - `'public'`: sign-in, sign-up and recovery run before there is a session. `validateToken` and
 *   `signout` must also answer a caller whose access token has expired: `validateToken` is the
 *   refresh-token exchange, and a 401 there would only send the client into another refresh.
 *   `resetPassword` without a reset token checks the session itself.
 * - `'user'`: the server answers 401 before the method runs when the request has no session.
 *
 * A subclass that overrides one of these keeps its level (the strictest one declared up the class
 * chain). A method a subclass adds is undeclared until the subclass declares it.
 */
declareCallable(AuthBackendProvider, {
  signinWithPassword: 'public',
  createAccount: 'public',
  signinOAuth: 'public',
  createOAuthNonce: 'public',
  signinTemporary: 'public',
  signinDev: 'public',
  sendResetPasswordLink: 'public',
  sendSigninCode: 'public',
  signinWithCode: 'public',
  resetPassword: 'public',
  verifyEmail: 'public',
  validateToken: 'public',
  signout: 'public',
  linkOAuthIdentity: 'user',
  resendEmailVerification: 'user',
  getReauthenticationMethods: 'user',
  removeAccount: 'user',
});

/**
 * Methods the server must never dispatch over HTTP, in any exposure mode. Backend-to-backend
 * calls are unaffected, and the declaration is inherited, so a subclass that overrides one of
 * these stays covered.
 *
 * These act on a credential, person or account the caller names, without checking who is asking.
 * Exposed, they would let anyone set a credential's password hash (`upgradePasswordHash`), read a
 * password hash (`getPasswordForUser`), create an account for any WebID (`getOrCreateAccount`),
 * or read an account's email or a person's details (`loadAccountForSession`,
 * `loadUserForSession`).
 */
declareInternal(AuthBackendProvider, [
  'upgradePasswordHash',
  'getPasswordForUser',
  'getOrCreateAccount',
  'loadAccountForSession',
  'loadUserForSession',
]);

/**
 * The request and token plumbing behind sign-in and refresh. They act on the caller's own request,
 * so reachable they would give a caller nothing it does not already have, but nothing on the
 * client calls them either (the client refreshes through `validateToken`).
 */
declareInternal(AuthBackendProvider, [
  'checkSignin',
  'validateRequestToken',
  'refreshSession',
  'getTokenFromRequest',
  'getTokenCandidates',
  'getRefreshTokenFromRequest',
]);
