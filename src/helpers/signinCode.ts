import crypto from 'crypto';
import { hashToken, tokenExpiresAt } from './credentialToken.js';
import { getJwtSecret } from '../utils/secrets.js';

/** How many digits an emailed sign-in code has. */
export const SIGNIN_CODE_LENGTH = 8;

/** A new sign-in code: `SIGNIN_CODE_LENGTH` random digits. */
export function generateSigninCode(): string {
  return crypto.randomInt(0, 10 ** SIGNIN_CODE_LENGTH).toString().padStart(SIGNIN_CODE_LENGTH, '0');
}

/** A typed code as it is checked: spaces and dashes removed. Empty for a non-string. */
export function normalizeSigninCode(code: unknown): string {
  return typeof code === 'string' ? code.replace(/[\s-]/g, '') : '';
}

/** An email as a code is bound to it: trimmed and lower-cased. */
export function normalizeSigninEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * HMAC-SHA256 of `value` (base64url), under a key derived from the server's JWT secret. What a
 * sign-in code and a pending email are stored by: a plain hash of an email is reversible with a
 * list of addresses, and of an email and eight digits by trying every code, so a copy of the store
 * alone would give away every live code. Deterministic, so it still works as a lookup key. A new
 * JWT secret makes outstanding codes stop working.
 */
function keyedDigest(value: string): string {
  const key = crypto.createHmac('sha256', getJwtSecret()).update('@_linked/auth sign-in code').digest();
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest('base64url');
}

/**
 * The token a sign-in code is stored and consumed as: the email and the code together, keyed
 * (see `keyedDigest`). Binding the code to its email means a lookup finds only that email's code,
 * and two people holding the same digits never meet.
 */
export function signinCodeSecret(email: string, code: string): string {
  return keyedDigest(`code\n${normalizeSigninEmail(email)}\n${normalizeSigninCode(code)}`);
}

/** What a pending credential stores in place of its email (`signinCodeEmailHash`). */
export function signinCodeEmailKey(email: string): string {
  return keyedDigest(`email\n${normalizeSigninEmail(email)}`);
}

/**
 * The `AuthCredential` fields that make `code` the credential's one outstanding sign-in code for
 * `email`, valid for `AUTH_SIGNIN_CODE_TTL` from `now`. Writing them replaces any earlier code.
 */
export function signinCodeFields(email: string, code: string, now: Date = new Date()) {
  return {
    signinCode: hashToken(signinCodeSecret(email, code)),
    signinCodeExpiresAt: tokenExpiresAt('signinCode', now),
  };
}
