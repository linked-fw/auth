import crypto from 'crypto';
import { Person } from '@_linked/schema/shapes/Person';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { AuthCredential } from '../shapes/AuthCredential.js';

/** The `AuthCredential` property that holds the hash of a single-use token. */
export type CredentialTokenField = 'forgotPasswordToken';

/** The `AuthCredential` property that holds when that token stops working. */
export type CredentialTokenExpiryField = 'forgotPasswordTokenExpiresAt';

/** A stored value as a Date (stores may return dateTime literals as strings). */
function toDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return isNaN(date.getTime()) ? undefined : date;
}

/**
 * Use up the single-use token whose stored hash is `hash`, atomically: of any number of
 * concurrent calls with the same hash, at most one gets the person back.
 *
 * The store has no compare-and-set and does not report what an update matched. But an update
 * with a `where` is one SPARQL `DELETE … INSERT … WHERE`, which the store runs as one write
 * transaction. So the update that removes the token also writes a fresh random marker, and only
 * the call whose update matched the token finds its own marker afterwards. A call that lost
 * matched nothing and wrote nothing.
 *
 * Expiry cannot be compared in a `where`, and the update removes it, so it is read before the
 * update. An expired token is still used up.
 *
 * @returns the person whose credential held the token if this call used it up and it had not
 *   expired, or undefined
 */
export async function consumeCredentialToken({
  tokenField,
  expiresField,
  hash,
  now = new Date(),
}: {
  tokenField: CredentialTokenField;
  expiresField: CredentialTokenExpiryField;
  hash: string;
  now?: Date;
}): Promise<QResult<Person> | undefined> {
  if (!hash || typeof hash !== 'string') return undefined;
  const stored = await AuthCredential.select((cred) => [cred.credentialOf, cred[expiresField]])
    .where((cred) => cred[tokenField].equals(hash))
    .one();
  if (!stored) return undefined;

  const marker = crypto.randomBytes(16).toString('base64url');
  await AuthCredential.update({
    [tokenField]: null,
    [expiresField]: null,
    consumeMarker: marker,
  }).where((cred) => cred[tokenField].equals(hash));

  const won = await AuthCredential.select((cred) => [cred.credentialOf])
    .where((cred) => cred.consumeMarker.equals(marker))
    .one();
  if (!won) return undefined;
  await AuthCredential.update({ consumeMarker: null }).for({ id: won.id });

  if (won.id !== stored.id) return undefined;
  const expiresAt = toDate(stored[expiresField]);
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) return undefined;
  return stored.credentialOf ?? undefined;
}
