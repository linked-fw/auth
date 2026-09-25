import { OAuth2Client, type TokenPayload } from 'google-auth-library';

export type GoogleTokenVerifier = (input: {
  idToken: string;
  audience: string[];
}) => Promise<TokenPayload | undefined>;

export type GoogleValidationOptions = {
  audiences?: Array<string | undefined>;
  verifier?: GoogleTokenVerifier;
};

export function buildGoogleTokenAudiences(
  ...values: Array<string | undefined>
): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean))] as string[];
}

const GoogleHelper = {
  /**
   * Validate Google ID token using Google Auth Library
   *
   * @param idToken - The Google ID token to validate
   * @returns Promise<GoogleTokenPayload | null> - The validated token payload or null if invalid
   */
  async validateIdToken(
    idToken: string,
    options: GoogleValidationOptions = {}
  ): Promise<TokenPayload | null> {
    try {
      if (!idToken) return null;
      const audiences = buildGoogleTokenAudiences(
        ...(options.audiences || [
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_ID_IOS,
          process.env.GOOGLE_CLIENT_ID_ANDROID,
        ])
      );

      if (audiences.length === 0) {
        console.error(
          'No Google Client IDs configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_ID_IOS, or GOOGLE_CLIENT_ID_ANDROID'
        );
        return null;
      }

      const verifier =
        options.verifier ||
        (async ({ idToken, audience }) => {
          const ticket = await new OAuth2Client().verifyIdToken({
            idToken,
            audience,
          });
          return ticket.getPayload();
        });
      const payload = await verifier({ idToken, audience: audiences });

      if (!payload) {
        console.error('Google ID token payload is null');
        return null;
      }

      // Validate required fields
      if (!payload.sub) {
        console.error('Google ID token missing sub field');
        return null;
      }

      if (!payload.email) {
        console.error('Google ID token missing email field');
        return null;
      }

      // Check if email is verified
      if (!payload.email_verified) {
        console.error('Google ID token email is not verified');
        return null;
      }

      return payload;
    } catch (error) {
      console.error('Error validating Google ID token:', error);
      return null;
    }
  },
};

export default GoogleHelper;
