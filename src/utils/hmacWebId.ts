import { createHmac } from 'node:crypto';

/**
 * Derives a WebID from an email with a keyed hash (arch-08 §Sign-in):
 *
 * ```
 * name   : trim(lowercase(email))
 * h      : first 128 bits of HMAC-SHA256(secret, name), as 32 hex characters
 * webID  : {issuer}/id/{h}#me
 * ```
 *
 * Only whoever holds `secret` can compute it, so a WebID does not reveal or confirm an email.
 * webid.email mints WebIDs with it, and an app's dev sign-in uses it with the dev secret so that
 * it gives the same WebID as a local webid.email. Server-only (`node:crypto`).
 *
 * A trailing `/` on `issuer` is ignored.
 */
export const hmacWebId = (
  email: string,
  { secret, issuer }: { secret: string; issuer: string }
): string => {
  if (!email || typeof email !== 'string' || !email.trim()) {
    throw new Error('Email must be a non-empty string');
  }
  if (!secret) throw new Error('hmacWebId needs a secret');
  if (!issuer) throw new Error('hmacWebId needs an issuer');

  const name = email.trim().toLowerCase();
  const h = createHmac('sha256', secret).update(name, 'utf8').digest('hex').slice(0, 32);
  return `${issuer.replace(/\/+$/, '')}/id/${h}#me`;
};

/**
 * The published test vector for `hmacWebId`. webid.email and apps' dev sign-in check their
 * derivation against it, so all of them give an email the same WebID. Do NOT change it.
 */
export const HMAC_WEBID_TEST_VECTOR = Object.freeze({
  email: 'alice@example.com',
  secret: 'webid-dev-secret',
  issuer: 'http://localhost:4050',
  webId: 'http://localhost:4050/id/9d4e3c342ed7dc86a07831ea7b5dd19e#me',
});
