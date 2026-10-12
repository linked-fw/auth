import { JwtPayload } from 'jsonwebtoken';
import { Person as SchemaPerson } from '@_linked/schema/shapes/Person';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { QResult } from '@_linked/core/queries/SelectQuery';
import type { RefreshTokenExpiry } from '../utils/token.js';

/**
 * The payload of the auth token use on backend.
 */
export interface AuthSessionPayload extends JwtPayload, AuthSession {}

/**
 * The result of a successful authentication use on backend.
 */
export type AuthenticationResult =
  | ({
      auth: AuthSession;
      accessToken: string;
      /** Only for native clients (body transport); browsers get it as an httpOnly cookie. */
      refreshToken?: string;
    } & RefreshTokenExpiry)
  | {
      error: string;
      action?: string;
      /** With `action: 'rate_limited'`: seconds until another attempt is accepted. */
      retryAfter?: number;
    };

/**
 * signin with OAuth provider
 */
export type OAuthProvider = 'facebook' | 'google' | 'apple';

/**
 * What a provider vouches for after its credential was verified on the server. Only `subject`
 * and (when verified) `email` decide which account is reached; the names only fill in a new
 * profile.
 */
export type VerifiedOAuthIdentity = {
  provider: OAuthProvider;
  /** The provider's stable user id (`sub`, or the Facebook user id). */
  subject: string;
  email?: string;
  /** True only when the provider states that the user controls `email`. */
  emailVerified: boolean;
  givenName?: string;
  familyName?: string;
};

/** The result of `linkOAuthIdentity`. */
export type LinkOAuthIdentityResult = { linked: true } | { error: string; action?: string };

/** The result of `verifyEmail`. */
export type VerifyEmailResult =
  | { verified: true }
  | { error: string; action?: string; retryAfter?: number };

/** The result of `resendEmailVerification`. `{verified: true}`: already verified, nothing sent. */
export type ResendEmailVerificationResult =
  | { sent: true }
  | { verified: true }
  | {
      error: string;
      action?: 'no_email' | 'rate_limited' | 'email_failed';
      retryAfter?: number;
    };

/**
 * Create a new account signin with email and password.
 */
export type CreateAccount = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
};

/**
 * The result of a successful authentication use on auth hook or frontend.
 */
export type AuthenticationResponse = {
  auth: AuthSession;
  accessToken: string;
  /** Only for native clients (body transport); browsers get it as an httpOnly cookie. */
  refreshToken?: string;
} & RefreshTokenExpiry;

export type UserData = QResult<
  SchemaPerson,
  {
    // givenName: string;
    // familyName?: string;
    // telephone?: string;
  }
>;

export type UserAccountData<User extends UserData = UserData> = QResult<
  UserAccount,
  {
    // email: string;
    accountOf: User;
  }
>;

export type AuthSession<UserAccount = UserAccountData, User = UserData> = {
  userAccount: UserAccount;
  user: User;
  /**
   * The session (refresh token family) the current access token belongs to. Set on the server
   * from the access token's `sid` claim; absent for tokens issued before sessions were stored.
   */
  sid?: string;
  /**
   * Whether the person has proved control of their email (see `personEmailVerified`). Read from
   * the store when the session is built (sign-in and refresh), so in an access token it can be
   * stale until the next refresh.
   */
  emailVerified?: boolean;
  updateSessionData?: (
    updatedData: Omit<AuthSession, 'updateSessionData'>
  ) => Promise<{
    auth: AuthSession;
    accessToken: string;
    /** Only for native clients (body transport); browsers get it as an httpOnly cookie. */
    refreshToken?: string;
  }>;
};

// EnforceSignedIn is the type of the result of the enforceSignedIn method
// when the user is not signed in
export type EnforceSignedIn = {
  [x: string]: string | any[];
  args: any[];
};
