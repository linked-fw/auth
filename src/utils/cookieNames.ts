/**
 * The prefix of every cookie this package sets and reads (server and client).
 *
 * Browsers do not separate cookies by port, so two Linked apps on one host (an app on
 * `localhost:4040` and a local issuer on `localhost:4050`) would share `accessToken`,
 * `refreshToken`, `linkedAuthSession` and the session cookie: signing out of one signs out the
 * other. Give each app its own prefix:
 *
 * - `AUTH_COOKIE_PREFIX` in the environment, read once on first use. The browser bundle reads
 *   `process.env.AUTH_COOKIE_PREFIX` too, which the app inlines into its client bundle (the
 *   Linked CLI's `createViteConfig({define})`);
 * - or `Auth.cookiePrefix = 'cn_'` (server) / `setCookiePrefix('cn_')`, which wins over the
 *   environment.
 *
 * The default is empty: the names stay `accessToken`, `refreshToken`, `linkedAuthSession` and
 * `linked.auth`. Allowed characters: letters, digits, `_`, `.` and `-`.
 */

const VALID_PREFIX = /^[A-Za-z0-9_.-]*$/;

let configured: string | undefined;
let fromEnv: string | undefined;

/**
 * `AUTH_COOKIE_PREFIX`, written out as `process.env.AUTH_COOKIE_PREFIX` (never `process.env[name]`)
 * so a bundler's `define` can inline it into the browser bundle. In a browser without it, the
 * bundler maps it to undefined, or `process` does not exist (caught).
 */
function readPrefixFromEnv(): string | undefined {
  try {
    return process.env.AUTH_COOKIE_PREFIX;
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
    fromEnv = checked(readPrefixFromEnv() ?? '', 'AUTH_COOKIE_PREFIX');
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
