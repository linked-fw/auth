/**
 * Server-side secrets for @_linked/auth.
 *
 * Outside development and test, a missing secret is a startup error rather than a silent
 * fallback: a hard-coded or derivable secret lets anyone mint valid access tokens (JWT) or
 * forge session cookies. Development and test keep a fixed fallback so a fresh checkout
 * runs without configuration, and warn about it once.
 */
import crypto from 'node:crypto';
import { brandLinkedError } from '@_linked/core/utils/linkedError';

/** The fallback JWT secret used in development and test only. */
export const DEV_JWT_SECRET = 'jwt-secret';

/**
 * A configuration error the server must not run with. `fatal: true` tells @_linked/server (from
 * the release that honours it) to abort startup instead of logging the failed provider hook and
 * serving anyway — which would leave a production deployment running with broken auth.
 */
export class FatalConfigError extends Error {
  readonly fatal = true;
  constructor(message: string) {
    super(message);
    this.name = 'FatalConfigError';
  }
}
// Branded so a host matches it from any copy of this package: `isLinkedError(err, FatalConfigError)`
// from `@_linked/core/utils/linkedError`.
brandLinkedError(FatalConfigError, '@_linked/auth', 'FatalConfigError');

const GENERATE_HINT = 'Generate one with: openssl rand -base64 48';

/** True when NODE_ENV is `development` or `test` — the only modes that allow fallbacks. */
export function isDevelopmentLikeEnv(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

const warned = new Set<string>();
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * The secret access tokens are signed and verified with.
 * Throws a FatalConfigError outside development/test when JWT_SECRET is not set.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) {
    return secret;
  }
  if (!isDevelopmentLikeEnv()) {
    throw new FatalConfigError(
      `@_linked/auth: JWT_SECRET is not set (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}). ` +
        'Access tokens cannot be signed or verified without it. ' +
        GENERATE_HINT
    );
  }
  warnOnce(
    'jwt',
    '@_linked/auth: JWT_SECRET is not set; using an insecure development fallback. ' +
      'This is refused outside NODE_ENV=development/test. ' +
      GENERATE_HINT
  );
  return DEV_JWT_SECRET;
}

/**
 * The express-session secret.
 * Throws a FatalConfigError outside development/test when SESSION_SECRET is not set.
 *
 * @param devFallbackSeed - what the development fallback is derived from
 */
export function getSessionSecret(devFallbackSeed: string): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    return secret;
  }
  if (!isDevelopmentLikeEnv()) {
    throw new FatalConfigError(
      `@_linked/auth: SESSION_SECRET is not set (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}). ` +
        'Session cookies cannot be signed securely without it. ' +
        GENERATE_HINT
    );
  }
  warnOnce(
    'session',
    '@_linked/auth: SESSION_SECRET is not set; using an insecure development fallback. ' +
      'This is refused outside NODE_ENV=development/test. ' +
      GENERATE_HINT
  );
  return crypto.createHash('md5').update(devFallbackSeed).digest('hex');
}

/**
 * Checks every secret this package needs, so a misconfigured deployment fails at startup
 * instead of on the first sign-in.
 */
export function assertAuthSecrets(devFallbackSeed: string): {
  jwtSecret: string;
  sessionSecret: string;
} {
  return {
    jwtSecret: getJwtSecret(),
    sessionSecret: getSessionSecret(devFallbackSeed),
  };
}
