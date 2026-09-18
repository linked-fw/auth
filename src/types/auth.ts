import { JwtPayload } from 'jsonwebtoken';
import { Person as FoafPerson } from 'foaf/shapes/Person';
import { Person as SchemaPerson } from '@_linked/schema/shapes/Person';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { QResult } from '@_linked/core/queries/SelectQuery';

/**
 * The payload of the auth token use on backend.
 */
export interface AuthSessionPayload extends JwtPayload, AuthSession {}

/**
 * The result of a successful authentication use on backend.
 */
export type AuthenticationResult =
  | {
      auth: AuthSession;
      accessToken: string;
      refreshToken: string;
    }
  | {
      error: string;
      action?: string;
    };

/**
 * signin with OAuth provider
 */
export type OAuthProvider = 'facebook' | 'google' | 'apple';

export type OAuthProfilePayload = {
  email?: string;
  name?: string;
  familyName?: string;
  givenName?: string;
  fullName?: string;
  imageUrl?: string;
};

export type GoogleOAuthPayload = OAuthProfilePayload & {
  authentication: { idToken: string };
};

export type AppleOAuthPayload = OAuthProfilePayload & {
  identityToken: string;
  authorizationCode?: string;
  nonce: string;
};

export type FacebookOAuthPayload = {
  accessToken: string;
};

export type OAuthPayloadMap = {
  google: GoogleOAuthPayload;
  apple: AppleOAuthPayload;
  facebook: FacebookOAuthPayload;
};

export type VerifiedOAuthIdentity = {
  provider: OAuthProvider;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  imageUrl?: string;
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
  refreshToken: string;
};

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
  updateSessionData?: (
    updatedData: Omit<AuthSession, 'updateSessionData'>
  ) => Promise<{
    auth: AuthSession;
    accessToken: string;
    refreshToken: string;
  }>;
};

// EnforceSignedIn is the type of the result of the enforceSignedIn method
// when the user is not signed in
export type EnforceSignedIn = {
  [x: string]: string | any[];
  args: any[];
};
