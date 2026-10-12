import jwksClient from 'jwks-rsa';
import jwt from 'jsonwebtoken';

const APPLE_ISSUER = 'https://appleid.apple.com';

// One client per process so jwks-rsa's key cache and rate limiting apply across sign-ins.
let appleJwksClient: ReturnType<typeof jwksClient> | undefined;

/**
 * The client IDs an Apple identity token may be issued to (its `aud`): the Services ID for
 * Sign in with Apple on the web (`APPLE_CLIENT_ID`) and the app's bundle ID for native sign-in
 * (`APPLE_CLIENT_ID_IOS`). Either variable may hold several comma-separated IDs.
 */
function configuredAppleClientIds(): string[] {
  return [process.env.APPLE_CLIENT_ID, process.env.APPLE_CLIENT_ID_IOS]
    .flatMap((value) => (value || '').split(','))
    .map((id) => id.trim())
    .filter(Boolean);
}

const AppleHelper = {
  /**
   * Fetches the public key from Apple's authentication service.
   * @param kid Key ID of the public key to fetch.
   * @returns The public key associated with the provided Key ID.
   */
  async key(kid: string) {
    appleJwksClient ??= jwksClient({
      jwksUri: 'https://appleid.apple.com/auth/keys',
      timeout: 30000,
    });

    return await appleJwksClient.getSigningKey(kid);
  },

  /**
   * Verifies the provided Apple identity token: Apple's signature (RS256), issuer
   * `https://appleid.apple.com`, an audience that is one of the configured Apple client IDs,
   * expiry, and a verified email.
   *
   * Fails closed: with no Apple client ID configured every token is rejected.
   *
   * @param identityToken The identity token to verify.
   * @returns The email, subject, issue time (`iat`, seconds) and (when present) nonce claim of the
   *   verified token, or null if the token is not valid.
   */
  async decodeIdentityToken(
    identityToken: string
  ): Promise<{ email: string | undefined; sub: string; iat?: number; nonce?: string } | null> {
    try {
      const audiences = configuredAppleClientIds();
      if (audiences.length === 0) {
        console.error(
          'No Apple client IDs configured, rejecting Apple sign-in. Set APPLE_CLIENT_ID (Services ID, web) and/or APPLE_CLIENT_ID_IOS (bundle ID, native)'
        );
        return null;
      }

      const decoded = jwt.decode(identityToken, { complete: true });
      const kid = decoded?.header?.kid;
      if (!kid) {
        console.error('Apple identity token is not a JWT or has no key ID');
        return null;
      }

      const publicKey = (await this.key(kid)).getPublicKey();
      const tokenLoad = jwt.verify(identityToken, publicKey, {
        algorithms: ['RS256'],
        issuer: APPLE_ISSUER,
        audience: audiences as [string, ...string[]],
      });
      if (typeof tokenLoad === 'string' || !tokenLoad.sub) {
        console.error('Apple identity token has no subject');
        return null;
      }

      const email: string | undefined = tokenLoad['email'];
      // Apple sends email_verified as the string "true" (or, in newer tokens, a boolean).
      const emailVerified = tokenLoad['email_verified'];
      if (email && emailVerified !== true && emailVerified !== 'true') {
        console.error('Apple identity token email is not verified');
        return null;
      }

      // the nonce claim is checked by the caller against the nonce the client sent back
      const nonce = typeof tokenLoad['nonce'] === 'string' ? tokenLoad['nonce'] : undefined;
      const iat = typeof tokenLoad.iat === 'number' ? tokenLoad.iat : undefined;
      const claims =
        iat === undefined ? { email, sub: tokenLoad.sub } : { email, sub: tokenLoad.sub, iat };
      return nonce ? { ...claims, nonce } : claims;
    } catch (error) {
      console.error('Error verifying Apple identity token:', error?.message ?? error);
      return null;
    }
  },
};

export default AppleHelper;
