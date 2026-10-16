/**
 * What every refused code sign-in answers: wrong, expired, used, or for another email.
 *
 * It lives here, not in the backend entry: the server constructs every export of a backend entry
 * as a provider, so a constant exported there fails to boot.
 */
export const INVALID_SIGNIN_CODE_MESSAGE = 'This sign-in code is invalid or has expired.';
