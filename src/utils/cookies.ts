/**
 * Auth cookies, set by the SERVER (server-only module).
 *
 * | Cookie | Value | httpOnly | SameSite | Path | Lifetime |
 * |---|---|---|---|---|---|
 * | `accessToken` | the access JWT | yes | Lax | `/` | until the token's `exp` |
 * | `refreshToken` | the opaque refresh token | yes | Strict | `/call/@_linked/auth` | until the record's expiry |
 * | `linkedAuthSession` | `1` | no | Lax | `/` | as the refresh token |
 *
 * - `accessToken` is what authenticates a full page load (server-side rendering): the browser
 *   sends it with the document request, the auth middleware verifies it and sets
 *   `request.linkedAuth`. Lax, so a signed-in user who follows a link from another site (an
 *   e-mail, a search result) still gets a signed-in first render.
 * - `refreshToken` is only sent to this package's RPC endpoints (`validateToken`, `signout`, …),
 *   so it never travels with page loads, asset requests or other packages' calls. Strict: it is
 *   only ever needed by same-site fetches.
 * - `linkedAuthSession` carries no secret. It tells the client that a refresh cookie exists, so
 *   an anonymous visitor's page load does not cost a refresh round trip.
 *
 * `Secure` is set when the request is https (`req.secure`, which honours Express's
 * `trust proxy`) or when `SITE_ROOT` is https. Behind a TLS-terminating proxy, set
 * `app.set('trust proxy', …)` so `req.secure` and `req.ip` are right; SITE_ROOT=https keeps the
 * cookies Secure even without it (and logs a warning once).
 *
 * Every name carries the prefix from `AUTH_COOKIE_PREFIX` / `Auth.cookiePrefix` (see
 * utils/cookieNames.ts; empty by default), so two Linked apps on one host keep separate sessions.
 *
 * Overrides: `AUTH_COOKIE_SECURE=true|false`, `AUTH_COOKIE_SAMESITE=lax|strict|none` (both
 * cookies; `none` forces Secure — for a frontend on another site), `AUTH_COOKIE_DOMAIN`,
 * `AUTH_REFRESH_COOKIE_PATH` (when the app is served under a path prefix).
 */
import {
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  TOKEN_TRANSPORT_BODY,
  TOKEN_TRANSPORT_HEADER,
  jwtExpiryMs,
} from './token.js';
import { authCookieName } from './cookieNames.js';

/** Base names, without the prefix; the cookies are named by the functions below. */
export const ACCESS_COOKIE = ACCESS_TOKEN;
export const REFRESH_COOKIE = REFRESH_TOKEN;
export const SESSION_HINT_COOKIE = 'linkedAuthSession';

/** The access token cookie's name under the current prefix. */
export const accessCookieName = () => authCookieName(ACCESS_COOKIE);
/** The refresh token cookie's name under the current prefix. */
export const refreshCookieName = () => authCookieName(REFRESH_COOKIE);
/** The session hint cookie's name under the current prefix. */
export const sessionHintCookieName = () => authCookieName(SESSION_HINT_COOKIE);
export const DEFAULT_REFRESH_COOKIE_PATH = '/call/@_linked/auth';

type SameSite = 'lax' | 'strict' | 'none';

export interface AuthCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite;
  path: string;
  domain?: string;
  maxAge?: number;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function refreshCookiePath(): string {
  return env('AUTH_REFRESH_COOKIE_PATH') ?? DEFAULT_REFRESH_COOKIE_PATH;
}

let warnedTrustProxy = false;

/** Should cookies for this request carry `Secure`? See the module comment. */
export function isSecureRequest(req: any): boolean {
  const override = env('AUTH_COOKIE_SECURE');
  if (override !== undefined) {
    return override === 'true' || override === '1';
  }
  const requestIsHttps = Boolean(req?.secure) || req?.protocol === 'https';
  if (requestIsHttps) return true;
  const siteIsHttps = /^https:/i.test(process.env.SITE_ROOT || '');
  if (siteIsHttps && req && !warnedTrustProxy) {
    warnedTrustProxy = true;
    console.warn(
      '@_linked/auth: SITE_ROOT is https but this request arrived over http. Auth cookies are ' +
        "still marked Secure. If TLS is terminated by a proxy, set app.set('trust proxy', ...) " +
        'so req.secure and req.ip reflect the client connection.'
    );
  }
  return siteIsHttps;
}

function sameSiteFor(defaultValue: SameSite): SameSite {
  const override = env('AUTH_COOKIE_SAMESITE')?.toLowerCase();
  if (override === 'lax' || override === 'strict' || override === 'none') return override;
  return defaultValue;
}

function baseOptions(req: any, sameSiteDefault: SameSite, path: string): AuthCookieOptions {
  const sameSite = sameSiteFor(sameSiteDefault);
  // browsers drop SameSite=None cookies that are not Secure
  const secure = sameSite === 'none' ? true : isSecureRequest(req);
  const domain = env('AUTH_COOKIE_DOMAIN');
  return { httpOnly: true, secure, sameSite, path, ...(domain ? { domain } : {}) };
}

export function accessCookieOptions(req: any, maxAgeMs?: number): AuthCookieOptions {
  return { ...baseOptions(req, 'lax', '/'), ...(maxAgeMs ? { maxAge: maxAgeMs } : {}) };
}

export function refreshCookieOptions(req: any, maxAgeMs?: number): AuthCookieOptions {
  return {
    ...baseOptions(req, 'strict', refreshCookiePath()),
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

export function sessionHintCookieOptions(req: any, maxAgeMs?: number): AuthCookieOptions {
  return {
    ...baseOptions(req, 'lax', '/'),
    httpOnly: false,
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

/**
 * The Express response of a request, if cookies can still be set on it. `res` defaults to
 * `req.res` (Express links the two); `false` means "do not set cookies".
 */
function writableResponse(req: any, res?: any): any {
  if (res === false) return undefined;
  const response = res ?? req?.res;
  if (!response || typeof response.cookie !== 'function' || response.headersSent) {
    return undefined;
  }
  return response;
}

/**
 * Did the client ask for the refresh token in the response body? Native clients do (header
 * `x-linked-auth-transport: body`, sent once the app calls `setAuthTokenStorageMethods`); browsers
 * get it as an httpOnly cookie only.
 */
export function wantsTokensInBody(req: any): boolean {
  const value = req?.headers?.[TOKEN_TRANSPORT_HEADER];
  return typeof value === 'string' && value.toLowerCase() === TOKEN_TRANSPORT_BODY;
}

/**
 * Set the auth cookies for a token response.
 *
 * - `accessToken`: always written when given (lives until its `exp`).
 * - `refreshToken`: written when a NEW refresh token was issued, with `refreshTokenExpiresAt`.
 *   The session hint cookie follows it. A cookie the client set from JS in an earlier release
 *   (refreshToken on path `/`) is cleared, so the token stops travelling with every request.
 */
export function setAuthCookies(
  req: any,
  res: any,
  {
    accessToken,
    refreshToken,
    refreshTokenExpiresAt,
  }: { accessToken?: string; refreshToken?: string; refreshTokenExpiresAt?: Date },
  now: number = Date.now()
): boolean {
  const response = writableResponse(req, res);
  if (!response) return false;
  if (accessToken) {
    const expMs = jwtExpiryMs(accessToken);
    const maxAge = expMs !== undefined ? expMs - now : undefined;
    if (maxAge === undefined || maxAge > 0) {
      response.cookie(accessCookieName(), accessToken, accessCookieOptions(req, maxAge));
    }
  }
  if (refreshToken) {
    const maxAge = refreshTokenExpiresAt ? refreshTokenExpiresAt.getTime() - now : undefined;
    if (maxAge === undefined || maxAge > 0) {
      response.cookie(refreshCookieName(), refreshToken, refreshCookieOptions(req, maxAge));
      response.cookie(sessionHintCookieName(), '1', sessionHintCookieOptions(req, maxAge));
      clearLegacyRefreshCookie(req, response);
    }
  }
  return true;
}

/**
 * Did the browser send a refresh cookie written on `/` by an earlier release (from JS)?
 *
 * On the auth endpoints the scoped cookie and a legacy one are both called `refreshToken`, and
 * the parsed `req.cookies` keeps only one, so this reads the raw Cookie header:
 * - two `refreshToken` values → the scoped one and a legacy one;
 * - one value without the `linkedAuthSession` hint → legacy (the server always sets the hint
 *   together with the scoped cookie, with the same lifetime).
 */
export function hasLegacyRefreshCookie(req: any): boolean {
  const raw: string = req?.headers?.cookie || '';
  if (!raw) return false;
  const names = raw.split(';').map((part) => part.trim().split('=')[0]);
  const refreshName = refreshCookieName();
  const refreshCount = names.filter((name) => name === refreshName).length;
  if (refreshCount >= 2) return true;
  return refreshCount === 1 && !names.includes(sessionHintCookieName());
}

function clearLegacyRefreshCookie(req: any, response: any) {
  if (refreshCookiePath() === '/') return;
  // only when the browser actually sent one: a cookie on `/` from an earlier release
  if (!hasLegacyRefreshCookie(req)) return;
  const { maxAge, ...options } = refreshCookieOptions(req);
  response.clearCookie(refreshCookieName(), { ...options, path: '/' });
}

/** Clear every auth cookie (sign-out, failed refresh, removed account). */
export function clearAuthCookies(req: any, res?: any): boolean {
  const response = writableResponse(req, res);
  if (!response) return false;
  const strip = ({ maxAge, ...options }: AuthCookieOptions) => options;
  response.clearCookie(accessCookieName(), strip(accessCookieOptions(req)));
  response.clearCookie(refreshCookieName(), strip(refreshCookieOptions(req)));
  response.clearCookie(sessionHintCookieName(), strip(sessionHintCookieOptions(req)));
  if (refreshCookiePath() !== '/') {
    response.clearCookie(refreshCookieName(), { ...strip(refreshCookieOptions(req)), path: '/' });
  }
  return true;
}

/**
 * Deliver a token response: set the cookies, and decide what stays in the body.
 *
 * The access token stays in the body (the client keeps it in memory for the `Authorization`
 * header and to schedule its refresh). The refresh token is removed from the body unless the
 * client asked for body transport (native clients), so browser JavaScript never sees it.
 *
 * @param newRefreshToken true when `result.refreshToken` was just issued (sign-in, rotation) and
 *   must be set as a cookie; false when it is merely echoed back.
 */
export function deliverTokens<T extends { accessToken?: string; refreshToken?: string }>(
  req: any,
  res: any,
  result: T,
  {
    refreshTokenExpiresAt,
    newRefreshToken = true,
  }: { refreshTokenExpiresAt?: Date; newRefreshToken?: boolean } = {}
): T {
  setAuthCookies(req, res, {
    accessToken: result.accessToken,
    refreshToken: newRefreshToken ? result.refreshToken : undefined,
    refreshTokenExpiresAt,
  });
  if (wantsTokensInBody(req)) return result;
  const { refreshToken, ...rest } = result;
  return rest as T;
}
