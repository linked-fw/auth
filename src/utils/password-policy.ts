/**
 * Password rules enforced on the server. RPC arguments arrive untyped, so the
 * forms' own validation is not something the backend can rely on.
 */
export const MIN_PASSWORD_LENGTH = 6;

/** A password that may be stored: a string of at least MIN_PASSWORD_LENGTH. */
export function isAcceptableNewPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH;
}

/**
 * A password that may be checked at sign-in. Anything that is not a non-empty
 * string is refused before a hash is looked at, so an account without a
 * password can never be entered with an empty one. Length is not enforced
 * here, so passwords set before the minimum existed keep working.
 */
export function isCheckablePassword(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
