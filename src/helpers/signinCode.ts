import crypto from 'crypto';
import { hashToken, tokenExpiresAt } from './credentialToken.js';

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
 * The token a sign-in code is stored and consumed as: the email and the code together. Binding
 * the code to its email means a lookup by its hash finds only that email's code, and two people
 * holding the same digits never meet.
 */
export function signinCodeSecret(email: string, code: string): string {
  return `${normalizeSigninEmail(email)}\n${normalizeSigninCode(code)}`;
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
