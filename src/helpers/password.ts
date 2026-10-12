import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Person } from '@_linked/schema/shapes/Person';
import { AuthCredential } from '../shapes/AuthCredential.js';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { readTtlFromEnv } from '../utils/token.js';

/**
 * The bcrypt cost (log2 of the rounds) of every new password hash. Hashes stored with a lower
 * cost (releases before 3.0.4 used 3, which bcrypt raises to its minimum of 4) are re-hashed at
 * this cost the next time their owner signs in. Native bcrypt takes roughly 80 ms per hash at 10.
 */
export const PASSWORD_HASH_COST = 10;

/** The shortest password accepted on signup, token reset and password change. */
export const MIN_PASSWORD_LENGTH = 6;

/** What every failed password sign-in answers, so it never tells whether the account exists. */
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email / password combination.';

/** The answer to a password that `isAcceptablePassword` refuses. */
export const INVALID_PASSWORD_RESULT = {
  error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  action: 'invalid_password',
} as const;

/** Whether `password` is a string of at least `MIN_PASSWORD_LENGTH` characters. */
export function isAcceptablePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

/** A hash of a random password at `PASSWORD_HASH_COST`, made on first use. */
let dummyHash: Promise<string> | undefined;

/** How long a password reset link works, in seconds, unless `AUTH_PASSWORD_RESET_TTL` is set. */
export const DEFAULT_PASSWORD_RESET_TTL = 60 * 60;

/**
 * How long a password reset link works, in seconds (`AUTH_PASSWORD_RESET_TTL`, default 1 hour).
 * Read once at startup; a value that is not a positive whole number throws.
 */
export const PASSWORD_RESET_TTL = readTtlFromEnv(
  'AUTH_PASSWORD_RESET_TTL',
  DEFAULT_PASSWORD_RESET_TTL
);

/** A stored value as a Date (stores may return dateTime literals as strings). */
function toDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return isNaN(date.getTime()) ? undefined : date;
}

/**
 * PasswordHelper
 */
const PasswordHelper = {
  /**
   * generate a hashed password
   *
   * @param plainTextPassword
   * @returns
   */
  async generateHashedPassword(plainTextPassword: string) {
    return bcrypt.hash(plainTextPassword, PASSWORD_HASH_COST);
  },

  /**
   * Whether a stored hash was made with a lower cost than `PASSWORD_HASH_COST`, and should be
   * replaced by a new hash of the password once that password is known to be right. A missing
   * or malformed hash never needs one (there is nothing valid to upgrade).
   */
  needsRehash(hashedPassword: string | undefined | null): boolean {
    if (!hashedPassword || typeof hashedPassword !== 'string') return false;
    try {
      return bcrypt.getRounds(hashedPassword) < PASSWORD_HASH_COST;
    } catch {
      return false;
    }
  },

  /**
   * generate a new token
   *
   * @returns
   */
  generateToken() {
    // before use this function to generate a new token, for now we change it to use crypto.randomBytes
    // const newToken = URL.createObjectURL(new Blob([])).slice(-36).replace(/-/g, '');
    return crypto.randomBytes(20).toString('hex');
  },

  /**
   * Compare the entered password with the hashed password
   *
   * @param enteredPassword
   * @param hashedPassword
   * @returns
   */
  async checkPassword(enteredPassword: string, hashedPassword: string) {
    const comparedPassword = await bcrypt
      .compare(enteredPassword, hashedPassword)
      .catch((err) => {
        console.error('This email and password combination is incorrect');
        return false;
      });

    return comparedPassword;
  },

  /**
   * Compare `plainPassword` with a fixed hash that nothing matches, and answer false. A sign-in
   * that finds no password calls this, so it takes about as long as a wrong password does.
   */
  async compareWithDummyHash(plainPassword: unknown): Promise<false> {
    dummyHash ??= bcrypt.hash(crypto.randomBytes(16).toString('hex'), PASSWORD_HASH_COST);
    const plain = typeof plainPassword === 'string' ? plainPassword : '';
    await bcrypt.compare(plain, await dummyHash).catch(() => false);
    return false;
  },

  /**
   * The value a password reset token is stored and looked up by: SHA-256, base64url. A plain
   * hash is enough, because the token is 160 random bits, not a password.
   */
  hashResetPasswordToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('base64url');
  },

  /**
   * The `AuthCredential` fields that make `token` the credential's one outstanding reset token,
   * valid for `PASSWORD_RESET_TTL` from `now`. Writing them replaces any earlier token.
   */
  resetPasswordTokenFields(token: string, now: Date = new Date()) {
    return {
      forgotPasswordToken: PasswordHelper.hashResetPasswordToken(token),
      forgotPasswordTokenExpiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL * 1000),
    };
  },

  /** The `AuthCredential` fields that remove the outstanding reset token (for `update`). */
  clearedResetPasswordTokenFields() {
    return { forgotPasswordToken: null, forgotPasswordTokenExpiresAt: null };
  },

  /**
   * Validate the reset password token, without using it up.
   *
   * Only a token issued by `sendResetPasswordLink` that has not expired is valid. Tokens stored
   * before reset links had an expiry (stored raw, without `forgotPasswordTokenExpiresAt`) never
   * are.
   *
   * @param token - The reset password token
   * @returns the person whose credential holds the token, or undefined
   */
  async validateResetPasswordToken(
    token: string,
    now: Date = new Date()
  ): Promise<QResult<Person> | undefined> {
    const credential = await PasswordHelper.findResetPasswordCredential(token);
    if (!credential) return undefined;
    const expiresAt = toDate(credential.forgotPasswordTokenExpiresAt);
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) return undefined;
    return credential.credentialOf;
  },

  /**
   * Validate the reset password token and use it up: the token is removed from its credential
   * whether or not it is still valid, so it never works again.
   *
   * @param token - The reset password token
   * @returns the person whose credential held the token if it was valid, or undefined
   */
  async consumeResetPasswordToken(
    token: string,
    now: Date = new Date()
  ): Promise<QResult<Person> | undefined> {
    const credential = await PasswordHelper.findResetPasswordCredential(token);
    if (!credential) return undefined;
    await AuthCredential.update(PasswordHelper.clearedResetPasswordTokenFields()).for({
      id: credential.id,
    });
    const expiresAt = toDate(credential.forgotPasswordTokenExpiresAt);
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) return undefined;
    return credential.credentialOf;
  },

  /** The credential whose outstanding reset token is `token`, if any. */
  async findResetPasswordCredential(token: string) {
    if (!token || typeof token !== 'string') return undefined;
    const tokenHash = PasswordHelper.hashResetPasswordToken(token);
    const credential = await AuthCredential.select((cred) => [
      cred.credentialOf,
      cred.forgotPasswordTokenExpiresAt,
    ])
      .where((cred) => {
        return cred.forgotPasswordToken.equals(tokenHash);
      })
      .one();
    return credential || undefined;
  },
};

export default PasswordHelper;
