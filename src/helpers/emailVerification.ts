import { AuthCredential } from '../shapes/AuthCredential.js';
import { hashToken, tokenExpiresAt } from './credentialToken.js';

/**
 * The `AuthCredential` fields that make `token` the credential's one outstanding verification
 * token, valid for `AUTH_EMAIL_VERIFICATION_TTL` from `now`. Writing them replaces any earlier
 * token.
 */
export function verificationTokenFields(token: string, now: Date = new Date()) {
  return {
    emailVerificationToken: hashToken(token),
    emailVerificationTokenExpiresAt: tokenExpiresAt('verify', now),
  };
}

/** The `AuthCredential` fields that remove the outstanding verification token (for `update`). */
export function clearedVerificationTokenFields() {
  return { emailVerificationToken: null, emailVerificationTokenExpiresAt: null };
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
