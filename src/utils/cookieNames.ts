/**
 * The prefix of every cookie this package sets and reads (server and client).
 *
 * Browsers do not separate cookies by port, so two Linked apps on one host (an app on
 * `localhost:4040` and a local issuer on `localhost:4050`) would share `accessToken`,
 * `refreshToken`, `linkedAuthSession` and the session cookie: signing out of one signs out the
 * other. Give each app its own prefix:
 *
 * - `AUTH_COOKIE_PREFIX` in the environment, read once on first use; in the browser it is
 *   read from `process.env` like the token lifetimes, so the app inlines it into its bundle
 *   (Vite `define`);
 * - or `Auth.cookiePrefix = 'cn_'` (server) / `setCookiePrefix('cn_')`, which wins over the
 *   environment.
 *
 * The default is empty: the names stay `accessToken`, `refreshToken`, `linkedAuthSession` and
 * `linked.auth`. Allowed characters: letters, digits, `_`, `.` and `-`.
 */

const VALID_PREFIX = /^[A-Za-z0-9_.-]*$/;

let configured: string | undefined;
let fromEnv: string | undefined;

function readEnv(name: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

function checked(prefix: string, source: string): string {
  if (!VALID_PREFIX.test(prefix)) {
    throw new Error(
      `@_linked/auth: ${source} may only contain letters, digits, "_", "." and "-", got "${prefix}"`
    );
  }
  return prefix;
}

/** The cookie-name prefix in effect ('' when none is set). */
export function getCookiePrefix(): string {
  if (configured !== undefined) return configured;
  if (fromEnv === undefined) {
    fromEnv = checked(readEnv('AUTH_COOKIE_PREFIX') ?? '', 'AUTH_COOKIE_PREFIX');
  }
  return fromEnv;
}

/**
 * Set the prefix (wins over `AUTH_COOKIE_PREFIX`). Set it before the backend's
 * `setupBeforeControllers` runs: the session middleware takes its cookie name then.
 * `undefined` returns to the environment's value.
 */
export function setCookiePrefix(prefix: string | undefined): void {
  configured = prefix === undefined ? undefined : checked(prefix, 'the cookie prefix');
}

/** The name a cookie of this package has under the current prefix. */
export function authCookieName(base: string): string {
  return getCookiePrefix() + base;
}
