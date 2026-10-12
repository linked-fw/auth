import crypto from 'crypto';
import { Person } from '@_linked/schema/shapes/Person';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { AuthCredential } from '../shapes/AuthCredential.js';
import { readTtlFromEnv } from '../utils/token.js';
import { consumeCredentialToken } from './credentialToken.js';

/** How long an email verification link works, in seconds, unless `AUTH_EMAIL_VERIFICATION_TTL` is set. */
export const DEFAULT_EMAIL_VERIFICATION_TTL = 7 * 24 * 60 * 60;

/**
 * How long an email verification link works, in seconds (`AUTH_EMAIL_VERIFICATION_TTL`, default
 * 7 days). Read once at startup; a value that is not a positive whole number throws.
 */
export const EMAIL_VERIFICATION_TTL = readTtlFromEnv(
  'AUTH_EMAIL_VERIFICATION_TTL',
  DEFAULT_EMAIL_VERIFICATION_TTL
);

/**
 * The value a verification token is stored and looked up by: SHA-256, base64url. A plain hash
 * is enough, because the token is 160 random bits, not a password.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * The `AuthCredential` fields that make `token` the credential's one outstanding verification
 * token, valid for `EMAIL_VERIFICATION_TTL` from `now`. Writing them replaces any earlier token.
 */
export function verificationTokenFields(token: string, now: Date = new Date()) {
  return {
    emailVerificationToken: hashToken(token),
    emailVerificationTokenExpiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL * 1000),
  };
}

/** The `AuthCredential` fields that remove the outstanding verification token (for `update`). */
export function clearedVerificationTokenFields() {
  return { emailVerificationToken: null, emailVerificationTokenExpiresAt: null };
}

/**
 * Use up a verification token, atomically (see `consumeCredentialToken`). The token is removed
 * whether or not it is still valid.
 *
 * @returns the person whose credential held the token if it was valid, or undefined
 */
export async function consumeEmailVerificationToken(
  token: string,
  now: Date = new Date()
): Promise<QResult<Person> | undefined> {
  if (!token || typeof token !== 'string') return undefined;
  return consumeCredentialToken({
    tokenField: 'emailVerificationToken',
    expiresField: 'emailVerificationTokenExpiresAt',
    hash: hashToken(token),
    now,
  });
}

/**
 * Record that the person controls their email: every credential of the person that is not
 * verified yet gets `emailVerifiedAt` and loses its outstanding verification token. A person
 * without any credential gets a new one with `email`. Calling it again changes nothing.
 */
export async function markEmailVerified(
  personId: string,
  email?: string,
  now: Date = new Date()
): Promise<void> {
  const credentials = await AuthCredential.select((cred) => [cred.emailVerifiedAt]).where(
    (cred) => cred.credentialOf.equals({ id: personId })
  );
  if (!credentials?.length) {
    await AuthCredential.create({
      credentialOf: { id: personId },
      ...(email ? { email } : {}),
      emailVerifiedAt: now,
    });
    return;
  }
  for (const credential of credentials) {
    if (credential.emailVerifiedAt) continue;
    await AuthCredential.update({
      emailVerifiedAt: now,
      ...clearedVerificationTokenFields(),
    }).for({ id: credential.id });
  }
}

/**
 * Whether any credential of the person has `emailVerifiedAt`. False on a store error, so a
 * session can always be built. Apps that gate a sensitive action on it should call this on the
 * server rather than trust the access token, which is only updated on its next refresh.
 */
export async function personEmailVerified(personId: string | undefined): Promise<boolean> {
  if (!personId) return false;
  try {
    const credentials = await AuthCredential.select((cred) => [cred.emailVerifiedAt]).where(
      (cred) => cred.credentialOf.equals({ id: personId })
    );
    return Boolean(credentials?.some((credential) => Boolean(credential.emailVerifiedAt)));
  } catch (error) {
    console.warn(
      '@_linked/auth: could not read whether an email is verified',
      error instanceof Error ? error.message : error
    );
    return false;
  }
}
