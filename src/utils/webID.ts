import { v5 as uuidv5 } from 'uuid';

const WEBID_PREFIX = 'https://webid.email/id';

/**
 * Public namespace UUID for the webid.email WebID scheme.
 * Used as the UUID v5 namespace when deriving a WebID from an email address.
 * This value is fixed and published. Do NOT change it; doing so would invalidate every WebID
 * `emailToWebID` has derived.
 */
export const WEBID_EMAIL_NAMESPACE = 'f498d4c9-555c-4ebb-9b4b-b6e16910f84c';

/**
 * Derives a deterministic, non-reversible WebID URI from an email address.
 *
 * Algorithm: UUID v5 (SHA-1, RFC 4122) using WEBID_EMAIL_NAMESPACE as the namespace
 * and the normalized (trimmed, lowercased) email as the name.
 *
 * The default of `Auth.webIdFor`. The algorithm is public, so anyone can compute the WebID of a
 * guessed email; webid.email mints its WebIDs with the keyed `hmacWebId` instead.
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

export interface HmacWebIdOptions {
  /** The HMAC key. Permanent: changing it changes every WebID derived with it. */
  secret: string;
  /** Base URL of the issuer that serves the WebIDs, without a trailing slash. */
  issuer: string;
}

const checkHmacWebIdOptions = ({ secret, issuer }: HmacWebIdOptions) => {
  if (!secret || typeof secret !== 'string') {
    throw new Error('hmacWebId: secret must be a non-empty string');
  }
  if (!issuer || typeof issuer !== 'string') {
    throw new Error('hmacWebId: issuer must be a non-empty string');
  }
  if (issuer.endsWith('/')) {
    throw new Error(`hmacWebId: issuer must not end with a slash: ${issuer}`);
  }
};

const hmacWebIdUnchecked = (email: string, { secret, issuer }: HmacWebIdOptions): string => {
  if (!email || typeof email !== 'string' || !email.trim()) {
    throw new Error('Email must be a non-empty string');
  }
  // Loaded at call time, not imported: browser code imports this module for emailToWebID, and a
  // static node:crypto import would end up in its bundle. HMAC derivation is server-only.
  const crypto = globalThis.process?.getBuiltinModule?.('node:crypto');
  if (!crypto) {
    throw new Error('hmacWebId runs only on the server (Node 22.3 or later)');
  }
  const h = crypto
    .createHmac('sha256', secret)
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
  return `${issuer}/id/${h}#me`;
};

/**
 * Derives a WebID from an email with a keyed hash, the rule webid.email mints WebIDs with
 * (arch-08 §WebID derivation):
 *
 *   name  : trim(lowercase(email))
 *   h     : first 128 bits of HMAC-SHA256(secret, name), as 32 lowercase hex characters
 *   webID : {issuer}/id/{h}#me
 *
 * Without the secret nobody can turn an email into a WebID or match a WebID to a guessed email.
 * Server-only. Throws on an empty email, an empty secret or issuer, or an issuer ending in `/`.
 */
export const hmacWebId = (email: string, options: HmacWebIdOptions): string => {
  checkHmacWebIdOptions(options);
  return hmacWebIdUnchecked(email, options);
};

/**
 * `hmacWebId` with its options bound, for `Auth.webIdFor`. The options are checked here, so a
 * misconfigured app fails when it sets the derivation rather than at the first sign-in.
 */
export const hmacWebIdFor = (options: HmacWebIdOptions): ((email: string) => string) => {
  checkHmacWebIdOptions(options);
  const { secret, issuer } = options;
  return (email: string) => hmacWebIdUnchecked(email, { secret, issuer });
};

/**
 * The published test vector for `hmacWebId`, with the local dev secret and the local webid.email
 * issuer. Every implementation of the rule (webid.email, Create Now's dev sign-in) asserts it.
 * The email has mixed case and surrounding spaces, so the vector covers normalisation too.
 */
export const HMAC_WEBID_TEST_VECTOR = Object.freeze({
  email: '  Alice@Example.COM ',
  secret: 'local-dev-webid-secret',
  issuer: 'http://localhost:4050',
  webId: 'http://localhost:4050/id/0e6ff1840253dc6191f36612a250decd#me',
});

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
