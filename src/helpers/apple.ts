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

    if (payload.nonce !== options.nonce) {
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

    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified,
    };
  },
};

export default AppleHelper;
