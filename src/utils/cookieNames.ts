/**
 * The prefix of every cookie this package sets and reads (server and client).
 *
 * Browsers do not separate cookies by port, so two Linked apps on one host (an app on
 * `localhost:4040` and a local issuer on `localhost:4050`) would share `accessToken`,
 * `refreshToken`, `linkedAuthSession` and the session cookie: signing out of one signs out the
 * other. So each app's cookies carry a prefix of their own, resolved in this order:
 *
 * 1. `Auth.cookiePrefix = 'cn_'` (server) / `setCookiePrefix('cn_')`;
 * 2. `AUTH_COOKIE_PREFIX` in the environment (unset or empty falls through);
 * 3. the app's own `APP_PREFIX`, made a safe cookie-name token plus `_` (`webid-email` →
 *    `webid-email_`, see {@link cookiePrefixFromAppPrefix});
 * 4. none: the names stay `accessToken`, `refreshToken`, `linkedAuthSession` and `linked.auth`.
 *
 * The environment is read once, on first use. The browser bundle reads
 * `process.env.AUTH_COOKIE_PREFIX` and `process.env.APP_PREFIX` too, which the app inlines into
 * its client bundle (the Linked CLI's `createViteConfig({define})`); defining
 * `process.env.AUTH_COOKIE_PREFIX` as {@link resolveCookiePrefix}`(process.env)` carries the
 * server's resolved prefix. Allowed characters: letters, digits, `_`, `.` and `-`.
 */

const VALID_PREFIX = /^[A-Za-z0-9_.-]*$/;

let configured: string | undefined;
let fromEnv: string | undefined;

/**
 * `AUTH_COOKIE_PREFIX` and `APP_PREFIX`, written out as `process.env.AUTH_COOKIE_PREFIX` and
 * `process.env.APP_PREFIX` (never `process.env[name]`) so a bundler's `define` can inline them into
 * the browser bundle. In a browser without them, the bundler maps them to undefined, or `process`
 * does not exist (caught).
 */
function readEnv(): { AUTH_COOKIE_PREFIX?: string; APP_PREFIX?: string } {
  return {
    AUTH_COOKIE_PREFIX: orUndefined(() => process.env.AUTH_COOKIE_PREFIX),
    APP_PREFIX: orUndefined(() => process.env.APP_PREFIX),
  };
}

function orUndefined(read: () => string | undefined): string | undefined {
  try {
    return read();
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

/**
 * The cookie prefix an app's `APP_PREFIX` gives: every run of characters other than letters,
 * digits, `_`, `.` and `-` becomes `-`, leading and trailing `-`, `_` and `.` are dropped, and `_`
 * is appended. `webid-email` → `webid-email_`, `cn` → `cn_`, `My App!` → `My-App_`; nothing left
 * (or no `APP_PREFIX`) gives `''`.
 */
export function cookiePrefixFromAppPrefix(appPrefix: string | undefined): string {
  const token = (appPrefix ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
  return token ? `${token}_` : '';
}

/**
 * The prefix an environment gives: `AUTH_COOKIE_PREFIX` when set and not empty (validated; invalid
 * throws), else {@link cookiePrefixFromAppPrefix}`(APP_PREFIX)`. An app's Vite config can define
 * the client's `process.env.AUTH_COOKIE_PREFIX` as `resolveCookiePrefix(process.env)`.
 */
export function resolveCookiePrefix(env: {
  AUTH_COOKIE_PREFIX?: string;
  APP_PREFIX?: string;
}): string {
  const explicit = env.AUTH_COOKIE_PREFIX;
  if (explicit) return checked(explicit, 'AUTH_COOKIE_PREFIX');
  return cookiePrefixFromAppPrefix(env.APP_PREFIX);
}

/** The cookie-name prefix in effect ('' when none is set). */
export function getCookiePrefix(): string {
  if (configured !== undefined) return configured;
  if (fromEnv === undefined) fromEnv = resolveCookiePrefix(readEnv());
  return fromEnv;
}

/**
 * Set the prefix (wins over `AUTH_COOKIE_PREFIX` and `APP_PREFIX`; `''` for none). Set it before
 * the backend's `setupBeforeControllers` runs: the session middleware takes its cookie name then.
 * `undefined` returns to the environment's prefix.
 */
export function setCookiePrefix(prefix: string | undefined): void {
  configured = prefix === undefined ? undefined : checked(prefix, 'the cookie prefix');
}

/** The name a cookie of this package has under the current prefix. */
export function authCookieName(base: string): string {
  return getCookiePrefix() + base;
}
