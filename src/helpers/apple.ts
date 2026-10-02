import crypto from 'node:crypto';
import jwksClient from 'jwks-rsa';
import jwt, { type JwtPayload } from 'jsonwebtoken';

export type AppleKeyResolver = (kid: string) => Promise<string>;

export type AppleTokenValidationOptions = {
  nonce: string;
  audiences: string[];
  keyResolver?: AppleKeyResolver;
};

export type VerifiedAppleIdentity = {
  sub: string;
  email?: string;
  emailVerified?: boolean;
};

export function buildAppleTokenAudiences(
  ...values: Array<string | undefined>
): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    ),
  ];
}

const appleJwks = jwksClient({
  jwksUri: 'https://appleid.apple.com/auth/keys',
  timeout: 30000,
});

const resolveAppleKey: AppleKeyResolver = async (kid) =>
  (await appleJwks.getSigningKey(kid)).getPublicKey();

function requirePayload(value: string | JwtPayload): JwtPayload {
  if (typeof value === 'string' || !value.sub) {
    throw new Error('Apple identity token is missing a subject');
  }
  return value;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * The nonce claim in an Apple identity token is whatever the client handed to
 * Apple. Native Sign in with Apple (and the Firebase convention most clients
 * follow) hands Apple SHA-256(rawNonce) as hex and keeps the raw nonce, which
 * is what reaches us; Apple JS on the web hands the nonce over unchanged.
 * Accept both, compared in constant time.
 *
 * Only the hashed form protects against replay: the raw nonce never appears in
 * the token, so someone holding a leaked token cannot produce it. With the
 * unhashed form the nonce can be read off the token itself, so it binds
 * nothing and only the token's expiry limits a replay.
 */
export function appleNonceMatches(
  tokenNonce: unknown,
  suppliedNonce: string
): boolean {
  if (typeof tokenNonce !== 'string' || !tokenNonce || !suppliedNonce) {
    return false;
  }
  const hashed = crypto
    .createHash('sha256')
    .update(suppliedNonce)
    .digest('hex');
  return (
    timingSafeEqualString(tokenNonce, hashed) ||
    timingSafeEqualString(tokenNonce, suppliedNonce)
  );
}

const AppleHelper = {
  async validateIdentityToken(
    identityToken: string,
    options: AppleTokenValidationOptions
  ): Promise<VerifiedAppleIdentity> {
    if (!identityToken) throw new Error('Apple identity token is required');
    if (!options.nonce) throw new Error('Apple nonce is required');

    const audiences = buildAppleTokenAudiences(...options.audiences);
    if (audiences.length === 0) {
      throw new Error('Apple token audiences are not configured');
    }

    const decoded = jwt.decode(identityToken, { complete: true });
    if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
      throw new Error('Apple identity token header is invalid');
    }
    if (decoded.header.alg !== 'RS256') {
      throw new Error('Apple identity token algorithm is invalid');
    }

    const publicKey = await (options.keyResolver || resolveAppleKey)(
      decoded.header.kid
    );
    const payload = requirePayload(
      jwt.verify(identityToken, publicKey, {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: audiences as [string, ...string[]],
      })
    );

    if (!appleNonceMatches(payload.nonce, options.nonce)) {
      throw new Error('Apple identity token nonce is invalid');
    }

    const emailVerified =
      payload.email_verified === true || payload.email_verified === 'true'
        ? true
        : payload.email_verified === false || payload.email_verified === 'false'
          ? false
          : undefined;
    if (typeof payload.email === 'string' && emailVerified !== true) {
      throw new Error('Apple identity token email is not verified');
    }

    // Private relay addresses (is_private_email) are verified by Apple like
    // any other address and are unique to this app, so they need no special
    // case: they can only ever match an account Apple sign-in created.
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified,
    };
  },
};

export default AppleHelper;
