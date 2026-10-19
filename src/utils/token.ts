import { Server } from '@_linked/server-utils/utils/Server';
import { sharedState } from '@_linked/core/utils/sharedState';

/**
 * Where the CLIENT keeps its tokens.
 *
 * - Web (the default): the server sets the tokens as httpOnly cookies (see utils/cookies.ts), so
 *   JavaScript never sees the refresh token. The access token the server returns in the response
 *   body is kept IN MEMORY only, for the `Authorization` header and for scheduling the next
 *   refresh. Nothing is written to `document.cookie`.
 * - Native (Capacitor and other non-browser clients): the app registers its own storage with
 *   `setAuthTokenStorageMethods`. The client then asks the server to return the refresh token in
 *   the response body (header `x-linked-auth-transport: body`), stores both tokens through those
 *   functions and passes the refresh token to `validateToken` / `signout` itself.
 *
 * The registered storage and the in-memory token are shared by every copy of this module in the
 * runtime: the app registers storage through one copy, and sign-in may run on another. See
 * https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md.
 */
const tokenState = sharedState('@_linked/auth', 'token', () => ({
  setTokenFn: undefined as
    | ((key: string, value: string, expires?: number) => Promise<void>)
    | undefined,
  getTokenFn: undefined as ((key: string) => Promise<string>) | undefined,
  removeTokenFn: undefined as ((key: string) => Promise<void>) | undefined,
  /**
   * In-memory access token of a web client. Not persisted anywhere: after a full page load the
   * server-rendered request is authenticated by the httpOnly cookie, and the client gets a token
   * in memory again with its next refresh.
   */
  memoryAccessToken: undefined as string | undefined,
}));

/** Header a client sends to receive the refresh token in the response body (native clients). */
export const TOKEN_TRANSPORT_HEADER = 'x-linked-auth-transport';
/** The value of TOKEN_TRANSPORT_HEADER that asks for tokens in the body. */
export const TOKEN_TRANSPORT_BODY = 'body';

/**
 * Register token storage for clients that cannot rely on cookies (native apps).
 * Once registered, tokens are stored and read through these functions and the server returns the
 * refresh token in response bodies. `expires` is in SECONDS.
 */
function setAuthTokenStorageMethods(
  getTokenFn: (key: string) => Promise<string>,
  setTokenFn: (key: string, value: string, expires?: number) => Promise<void>,
  removeTokenFn: (key: string) => Promise<void>
) {
  tokenState.getTokenFn = getTokenFn;
  tokenState.setTokenFn = setTokenFn;
  tokenState.removeTokenFn = removeTokenFn;
  try {
    Server.addDefaultHeaders({ [TOKEN_TRANSPORT_HEADER]: TOKEN_TRANSPORT_BODY });
  } catch {
    // no server proxy (SITE_ROOT unset); the header is only needed for server calls
  }
}

/** True when the app registered its own token storage (native clients). */
function isNativeTokenStorage(): boolean {
  return Boolean(tokenState.getTokenFn && tokenState.setTokenFn && tokenState.removeTokenFn);
}

// token keys (also the cookie names the server uses)
const ACCESS_TOKEN = 'accessToken';
const REFRESH_TOKEN = 'refreshToken';

/**
 * Token and session lifetimes, in SECONDS. Read on the SERVER from the environment; in the
 * browser `process.env` is usually not populated, so the client falls back to the defaults —
 * which only matters for native storage expiry, because the server returns the real expiry with
 * every token response and the access token carries its own `exp`.
 *
 * | Variable | development | otherwise |
 * |---|---|---|
 * | `AUTH_ACCESS_TOKEN_TTL` | 1 hour | 15 minutes |
 * | `AUTH_REFRESH_TOKEN_TTL` | 30 days | 60 days |
 * | `AUTH_SESSION_IDLE_TTL` | 7 days | 7 days |
 * | `AUTH_SESSION_MAX_TTL` | 60 days | 60 days |
 *
 * - The access token is short-lived because it cannot be revoked: it stays valid until `exp`
 *   after sign-out. The client refreshes it about a minute before it expires. Development keeps
 *   an hour so a paused debugger or a restarting dev server does not cost a sign-in, and so the
 *   refresh traffic does not drown the dev log; it still exercises the refresh scheduler.
 * - A refresh token is valid for at most `AUTH_REFRESH_TOKEN_TTL`, and every refresh replaces it.
 * - A session (all rotations of one sign-in) ends when it has not been refreshed for
 *   `AUTH_SESSION_IDLE_TTL` (sliding), and at the latest `AUTH_SESSION_MAX_TTL` after the
 *   sign-in, however active it is. `0` switches either limit off.
 * Each new refresh token expires at the earliest of the three.
 */
const isDevelopment =
  typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DEFAULT_ACCESS_TOKEN_TTL = isDevelopment ? HOUR : 15 * MINUTE;
const DEFAULT_REFRESH_TOKEN_TTL = isDevelopment ? 30 * DAY : 60 * DAY;
const DEFAULT_SESSION_IDLE_TTL = 7 * DAY;
const DEFAULT_SESSION_MAX_TTL = 60 * DAY;

function readEnv(name: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A lifetime in whole seconds from the environment. `allowZero` lets `0` mean "no limit".
 * Throws on anything else that is not a whole number, so a typo is not silently ignored.
 */
function readTtlFromEnv(
  name: string,
  fallback: number,
  { allowZero = false }: { allowZero?: boolean } = {}
): number {
  const raw = readEnv(name);
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || (value === 0 && !allowZero)) {
    throw new Error(
      `@_linked/auth: ${name} must be a ${allowZero ? 'non-negative' : 'positive'} whole number of seconds, got "${raw}"`
    );
  }
  return value;
}

/** Access token lifetime in seconds. */
const ACCESS_TOKEN_EXPIRES = readTtlFromEnv('AUTH_ACCESS_TOKEN_TTL', DEFAULT_ACCESS_TOKEN_TTL);
/** Refresh token lifetime in seconds (an upper bound; see the session limits). */
const REFRESH_TOKEN_EXPIRES = readTtlFromEnv('AUTH_REFRESH_TOKEN_TTL', DEFAULT_REFRESH_TOKEN_TTL);
/** A session not refreshed for this many seconds ends. 0 = no idle limit. */
const SESSION_IDLE_TTL = readTtlFromEnv('AUTH_SESSION_IDLE_TTL', DEFAULT_SESSION_IDLE_TTL, {
  allowZero: true,
});
/** A session ends this many seconds after its sign-in, however active. 0 = no limit. */
const SESSION_MAX_TTL = readTtlFromEnv('AUTH_SESSION_MAX_TTL', DEFAULT_SESSION_MAX_TTL, {
  allowZero: true,
});

/**
 * Read a token. Native: from the registered storage. Web: the access token from memory; the
 * refresh token is an httpOnly cookie and is never readable (always undefined).
 */
async function getAuthToken(key: string): Promise<string | undefined> {
  if (tokenState.getTokenFn) {
    return await tokenState.getTokenFn(key);
  }
  return key === ACCESS_TOKEN ? tokenState.memoryAccessToken : undefined;
}

/**
 * Store a token. Native: through the registered storage (`expires` in SECONDS). Web: the access
 * token goes to memory; a refresh token is ignored (the server already set it as a cookie).
 */
async function setAuthToken({
  key,
  value,
  expires,
}: {
  key: string;
  value: string;
  expires?: number;
}) {
  if (tokenState.setTokenFn) {
    await tokenState.setTokenFn(key, value, expires);
  } else if (key === ACCESS_TOKEN) {
    tokenState.memoryAccessToken = value;
  }
}

/** Remove a token. Native: from the registered storage. Web: from memory (cookies are the server's). */
async function removeAuthToken(key: string) {
  if (tokenState.removeTokenFn) {
    await tokenState.removeTokenFn(key);
  } else if (key === ACCESS_TOKEN) {
    tokenState.memoryAccessToken = undefined;
  }
}

/** Decode a JWT payload WITHOUT verifying it (the server verifies). Undefined if unreadable. */
function decodeJwtPayload(token: string): Record<string, any> | undefined {
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json =
      typeof atob === 'function'
        ? decodeURIComponent(
            Array.from(atob(base64), (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
          )
        : Buffer.from(base64, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** A JWT's `exp` in milliseconds, read without verifying it. */
function jwtExpiryMs(token: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

/**
 * Seconds until a JWT's `exp`, read without verifying it. Undefined when the token cannot be
 * read or has already expired.
 */
function secondsUntilJwtExpiry(token: string, nowMs: number = Date.now()): number | undefined {
  const expMs = jwtExpiryMs(token);
  if (expMs === undefined) return undefined;
  const seconds = Math.floor((expMs - nowMs) / 1000);
  return seconds > 0 ? seconds : undefined;
}

/**
 * When the refresh token the server just issued (or confirmed) stops being valid.
 *
 * The server's lifetimes are not visible in the browser, so it returns the record's expiry with
 * every token response. `refreshTokenExpiresIn` (seconds from the response) is used first because
 * it does not depend on the client's clock.
 */
export interface RefreshTokenExpiry {
  /** Seconds from the response until the refresh token expires. */
  refreshTokenExpiresIn?: number;
  /** The refresh token's expiry as an ISO date-time. */
  refreshTokenExpiresAt?: string;
}

/** The expiry fields a server sends for a refresh token expiring at `expiresAt`. */
function refreshTokenExpiryFields(
  expiresAt: Date | undefined,
  now: Date = new Date()
): RefreshTokenExpiry {
  if (!expiresAt || isNaN(expiresAt.getTime())) return {};
  return {
    refreshTokenExpiresAt: expiresAt.toISOString(),
    refreshTokenExpiresIn: Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
  };
}

/** Seconds the refresh token should be kept, from the server's expiry fields if present. */
function secondsUntilRefreshExpiry(
  expiry: RefreshTokenExpiry | undefined,
  nowMs: number = Date.now()
): number | undefined {
  const inSeconds = expiry?.refreshTokenExpiresIn;
  if (typeof inSeconds === 'number' && Number.isFinite(inSeconds) && inSeconds > 0) {
    return Math.floor(inSeconds);
  }
  if (expiry?.refreshTokenExpiresAt) {
    const atMs = Date.parse(expiry.refreshTokenExpiresAt);
    if (!isNaN(atMs) && atMs > nowMs) {
      return Math.floor((atMs - nowMs) / 1000);
    }
  }
  return undefined;
}

/**
 * Store the tokens of an authentication response.
 *
 * Web: only the access token is kept, in memory. Native: both go to the registered storage — the
 * access token until its `exp`, the refresh token until the expiry the server returned (or the
 * client default, unless it is the token already stored, which is then left alone).
 */
async function storeAuthTokens({
  accessToken,
  refreshToken,
  refreshTokenExpiresIn,
  refreshTokenExpiresAt,
}: {
  accessToken?: string;
  refreshToken?: string;
} & RefreshTokenExpiry): Promise<void> {
  if (accessToken) {
    await setAuthToken({
      key: ACCESS_TOKEN,
      value: accessToken,
      expires: secondsUntilJwtExpiry(accessToken) ?? ACCESS_TOKEN_EXPIRES,
    });
  }
  if (refreshToken && isNativeTokenStorage()) {
    const expires = secondsUntilRefreshExpiry({ refreshTokenExpiresIn, refreshTokenExpiresAt });
    if (expires === undefined && (await getAuthToken(REFRESH_TOKEN)) === refreshToken) {
      return;
    }
    await setAuthToken({
      key: REFRESH_TOKEN,
      value: refreshToken,
      expires: expires ?? REFRESH_TOKEN_EXPIRES,
    });
  }
}

export {
  getAuthToken,
  storeAuthTokens,
  decodeJwtPayload,
  jwtExpiryMs,
  secondsUntilJwtExpiry,
  secondsUntilRefreshExpiry,
  refreshTokenExpiryFields,
  setAuthToken,
  removeAuthToken,
  setAuthTokenStorageMethods,
  isNativeTokenStorage,
  readTtlFromEnv,
  ACCESS_TOKEN_EXPIRES,
  REFRESH_TOKEN_EXPIRES,
  SESSION_IDLE_TTL,
  SESSION_MAX_TTL,
  ACCESS_TOKEN,
  REFRESH_TOKEN,
};
