import { v5 as uuidv5 } from 'uuid';

const WEBID_PREFIX = 'https://webid.email/id';

/**
 * Public namespace UUID for the webid.email WebID scheme.
 * Used as the UUID v5 namespace when deriving a WebID from an email address.
 * This value is fixed and published — both CN and the webid.email service use it.
 * Do NOT change this value; doing so would invalidate all existing WebID URIs.
 */
export const WEBID_EMAIL_NAMESPACE = 'f498d4c9-555c-4ebb-9b4b-b6e16910f84c';

/**
 * Derives a deterministic, non-reversible WebID URI from an email address.
 *
 * Algorithm: UUID v5 (SHA-1, RFC 4122) using WEBID_EMAIL_NAMESPACE as the namespace
 * and the normalized (trimmed, lowercased) email as the name.
 *
 * The algorithm is public. Knowing the WebID does not reveal the email address.
 * Both CN (dev mode) and the webid.email service (production) use the same algorithm,
 * so WebIDs are identical across environments.
 *
 * e.g. alice@example.com -> https://webid.email/id/550e8400-e29b-41d4-a716-...
 */
export const emailToWebID = (email: string): string => {
  if (!email || typeof email !== 'string') {
    throw new Error('Email must be a non-empty string');
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (
    !normalizedEmail ||
    !normalizedEmail.includes('@') ||
    normalizedEmail.indexOf('@') === 0 ||
    normalizedEmail.indexOf('@') === normalizedEmail.length - 1
  ) {
    console.warn(`Potentially invalid email format: ${normalizedEmail}`);
  }

  return `${WEBID_PREFIX}/${uuidv5(normalizedEmail, WEBID_EMAIL_NAMESPACE)}`;
};

/**
 * @deprecated WebIDs are now opaque UUID v5 values — reversing a WebID to an email
 * is no longer possible. Replace all callers with a UserAccount.email query:
 *   const account = await UserAccount.select(a => [a.email]).where(a => a.accountOf.equals({ id: webID })).one();
 *   const email = account?.email;
 *
 * This stub returns null unconditionally so callers fail visibly rather than silently.
 */
export const webIDToEmail = (_webID: string): string | null => {
  return null;
};

/**
 * Public namespace UUID for phone-based WebIDs.
 * Separate from WEBID_EMAIL_NAMESPACE so a phone string and the same string-as-email
 * cannot collide to produce the same WebID.
 * Fixed value — do NOT change; would invalidate all existing phone-based WebIDs.
 */
export const WEBID_PHONE_NAMESPACE = '8b2df419-565d-4aeb-9f77-2817a35214c1';

/**
 * Derives a deterministic, non-reversible WebID URI from a phone number.
 *
 * Algorithm: UUID v5 (SHA-1, RFC 4122) using WEBID_PHONE_NAMESPACE as the namespace
 * and the normalized phone (digits-only, trimmed) as the name.
 *
 * Normalization strips all non-digit characters, so `+1 (202) 555-0100`,
 * `12025550100`, and `+1-202-555-0100` all produce the same WebID.
 */
export const telephoneToWebID = (phone: string): string => {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Phone must be a non-empty string');
  }
  const normalizedPhone = phone.trim().replace(/\D+/g, '');
  if (!normalizedPhone) {
    throw new Error('Phone must contain at least one digit');
  }
  return `${WEBID_PREFIX}/${uuidv5(normalizedPhone, WEBID_PHONE_NAMESPACE)}`;
};

/** Turns a (verified) email into the IRI of its Person. */
export type WebIdDerivation = (email: string) => string;

let configuredWebIdFor: WebIdDerivation = emailToWebID;

/**
 * Sets how auth turns an email into a Person IRI: at sign-in, sign-up, password reset and OAuth
 * sign-in. Call it once at server startup, before the first request. `null` restores the default,
 * `emailToWebID`, which every app uses until it sets something else, so existing WebIDs stay.
 *
 * e.g. `setWebIdFor((email) => hmacWebId(email, {secret, issuer}))` with `hmacWebId` from
 * `@_linked/auth/utils/hmacWebId`.
 */
export const setWebIdFor = (derivation: WebIdDerivation | null): void => {
  configuredWebIdFor = derivation ?? emailToWebID;
};

/** The Person IRI for `email`, by the derivation set with `setWebIdFor` (default `emailToWebID`). */
export const webIdFor = (email: string): string => configuredWebIdFor(email);
