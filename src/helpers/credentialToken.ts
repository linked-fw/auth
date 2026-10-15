import crypto from 'crypto';
import { Person } from '@_linked/schema/shapes/Person';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { AuthCredential } from '../shapes/AuthCredential.js';
import { readTtlFromEnv } from '../utils/token.js';
import { toDate } from '../utils/date.js';

/** How long a password reset link works, in seconds, unless `AUTH_PASSWORD_RESET_TTL` is set. */
export const DEFAULT_PASSWORD_RESET_TTL = 60 * 60;

/** How long an emailed sign-in code works, in seconds, unless `AUTH_SIGNIN_CODE_TTL` is set. */
export const DEFAULT_SIGNIN_CODE_TTL = 15 * 60;

/**
 * The single-use tokens a credential can hold, each emailed (as a link, or a code and a link). Per kind: the
 * `AuthCredential` properties that hold its hash, its expiry and its consume marker, and how long
 * a new token works, in seconds. The lifetimes are read once at startup; a value that is not a
 * positive whole number throws.
 *
 * - `reset`: a password reset link (`AUTH_PASSWORD_RESET_TTL`, default 1 hour).
 * - `verify`: an email verification link (`AUTH_EMAIL_VERIFICATION_TTL`, default 7 days).
 * - `signinCode`: a sign-in code and link (`AUTH_SIGNIN_CODE_TTL`, default 15 minutes). Its token
 *   is the email and the code together (see `signinCodeSecret`).
 */
export const TOKEN_KINDS = {
  reset: {
    tokenField: 'forgotPasswordToken',
    expiresField: 'forgotPasswordTokenExpiresAt',
    markerField: 'passwordResetConsumeMarker',
    ttl: readTtlFromEnv('AUTH_PASSWORD_RESET_TTL', DEFAULT_PASSWORD_RESET_TTL),
  },
  verify: {
    tokenField: 'emailVerificationToken',
    expiresField: 'emailVerificationTokenExpiresAt',
    markerField: 'emailVerificationConsumeMarker',
    ttl: readTtlFromEnv('AUTH_EMAIL_VERIFICATION_TTL', 7 * 24 * 60 * 60),
  },
  signinCode: {
    tokenField: 'signinCode',
    expiresField: 'signinCodeExpiresAt',
    markerField: 'signinCodeConsumeMarker',
    ttl: readTtlFromEnv('AUTH_SIGNIN_CODE_TTL', DEFAULT_SIGNIN_CODE_TTL),
  },
} as const;

/** A kind of single-use credential token (see `TOKEN_KINDS`). */
export type CredentialTokenKind = keyof typeof TOKEN_KINDS;

/**
 * The value a single-use token is stored and looked up by: SHA-256, base64url. For links a plain
 * hash is enough, because the token is 160 random bits, not a password. A sign-in code is six
 * digits: its hash binds it to an email, and what stops guessing is the per-email rate limit on
 * `signinWithCode` and the code's short lifetime, not the hash.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** When a token of `kind` issued at `now` stops working. */
export function tokenExpiresAt(kind: CredentialTokenKind, now: Date = new Date()): Date {
  return new Date(now.getTime() + TOKEN_KINDS[kind].ttl * 1000);
}

/**
 * Remove a token of `kind` whose email was never sent, so no link exists for it. Matched by the
 * token's hash, so a newer link issued in the meantime is left alone. A store error is logged.
 */
export async function clearUnsentToken(kind: CredentialTokenKind, hash: string): Promise<void> {
  const { tokenField, expiresField } = TOKEN_KINDS[kind];
  try {
    await AuthCredential.update({ [tokenField]: null, [expiresField]: null }).where((cred) =>
      cred[tokenField].equals(hash)
    );
  } catch (error) {
    console.error(`Could not remove an unsent ${kind} token`, error);
  }
}

/**
 * Use up the single-use token of `kind`, atomically: of any number of concurrent calls with the
 * same token, at most one gets the person back.
 *
 * The store has no compare-and-set and does not report what an update matched. But an update
 * with a `where` is one SPARQL `DELETE … INSERT … WHERE`, which the store runs as one write
 * transaction. So the update that removes the token also writes a fresh random marker, and only
 * the call whose update matched the token finds its own marker afterwards. A call that lost
 * matched nothing and wrote nothing. Each kind has its own marker property, so using up one kind
 * never disturbs a concurrent consume of the other on the same credential.
 *
 * Expiry cannot be compared in a `where`, and the update removes it, so it is read before the
 * update. An expired token is still used up.
 *
 * @returns the person whose credential held the token if this call used it up and it had not
 *   expired, or undefined
 */
export async function consumeCredentialToken(
  kind: CredentialTokenKind,
  token: string,
  now: Date = new Date()
): Promise<QResult<Person> | undefined> {
  return (await consumeCredentialTokenRecord(kind, token, now))?.person;
}

/**
 * `consumeCredentialToken`, answering with the credential that held the token as well: its id,
 * and its person when it has one (a credential holding a sign-in code for an email with no
 * account yet belongs to nobody).
 *
 * @returns the credential if this call used the token up and it had not expired, or undefined
 */
export async function consumeCredentialTokenRecord(
  kind: CredentialTokenKind,
  token: string,
  now: Date = new Date()
): Promise<{ credentialId: string; person?: QResult<Person> } | undefined> {
  if (!token || typeof token !== 'string') return undefined;
  const { tokenField, expiresField, markerField } = TOKEN_KINDS[kind];
  const hash = hashToken(token);
  const stored = await AuthCredential.select((cred) => [cred.credentialOf, cred[expiresField]])
    .where((cred) => cred[tokenField].equals(hash))
    .one();
  if (!stored) return undefined;

  const marker = crypto.randomBytes(16).toString('base64url');
  await AuthCredential.update({
    [tokenField]: null,
    [expiresField]: null,
    [markerField]: marker,
  }).where((cred) => cred[tokenField].equals(hash));

  const won = await AuthCredential.select((cred) => [cred.credentialOf])
    .where((cred) => cred[markerField].equals(marker))
    .one();
  if (!won) return undefined;
  // the marker has done its job; it must not stay behind on the credential
  await AuthCredential.update({ [markerField]: null }).for({ id: won.id });

  // the expiry read above belongs to `stored`, so it only applies to that same credential
  if (won.id !== stored.id) return undefined;
  const expiresAt = toDate(stored[expiresField]);
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) return undefined;
  return { credentialId: stored.id, person: stored.credentialOf ?? undefined };
}
