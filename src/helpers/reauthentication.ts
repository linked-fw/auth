/**
 * How old a provider's ID token may be to confirm an account deletion, in milliseconds. The
 * token's own expiry (about an hour for Google) is too long for a "you just signed in" check:
 * any token the browser still holds from an earlier sign-in would pass.
 */
export const REAUTH_MAX_TOKEN_AGE = 10 * 60 * 1000;
