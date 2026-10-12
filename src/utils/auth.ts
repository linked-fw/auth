import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { Person, Person as SchemaPerson } from '@_linked/schema/shapes/Person';
import type { Shape } from '@_linked/core/shapes/Shape';
import { Server } from '@_linked/server-utils/utils/Server';
import { ENFORCE_SIGNED_IN } from '../hooks/useAuth.js';
import type {
  AuthenticationResult,
  AuthSession,
  EnforceSignedIn,
  UserAccountData,
  UserData,
} from '../types/auth.js';
import { createAccessToken, createToken } from './jwt.js';
import { findRefreshTokenExpiry } from './sessions.js';
import { refreshTokenExpiryFields } from './token.js';
import { deliverTokens } from './cookies.js';
import type { RefreshTokenExpiry } from './token.js';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider.js';
import { setQueryContext } from '@_linked/core/queries/QueryContext';

export class Auth {
  // define the default user and account types
  // Widened from `typeof SchemaPerson | typeof FoafPerson`: `foaf` was the last
  // legacy `lincd` package in this dependency tree and the union was type-only.
  // `AuthProviderProps.userType` already used `typeof Shape`.
  static userType: typeof Shape = SchemaPerson;
  static accountType: typeof UserAccount = UserAccount;

  /**
   * Login method
   *
   * @param request - The incoming request
   * @param findAccount - Function to find an existing account, will log in with this account if it's found
   * @param createAccount - Function to set new data for the user and account
   * @param logMethodName - Name of the log method
   * @returns - Returns the result of the sign-in process
   */
  static async login(
    provider,
    findAccount: () => Promise<{
      account: QResult<UserAccount>;
      person: QResult<Shape>;
    }>,
    createAccount: () => Promise<{
      account: QResult<UserAccount>;
      person: QResult<Shape>;
    }>,
    logMethodName: string
  ): Promise<AuthenticationResult> {
    console.log(`login method: ${logMethodName}`);

    let person, account;
    const existing = await findAccount();

    if (existing) {
      person = existing.person;
      account = existing.account;
    } else {
      // uri = process.env.DATA_ROOT + '/account_' + luid;
      const newAccount = await createAccount();
      person = newAccount.person;
      account = newAccount.account;
    }

    return this.onSigninSuccessful(provider, person, account, !existing);
  }

  /**
   * Enforces that the user is signed in. If not, it will return a response action to enforce sign in.
   * @returns - Returns a response action to enforce sign in.
   */
  static enforceSignedIn(): EnforceSignedIn {
    return Server.createResponseAction(ENFORCE_SIGNED_IN);
  }

  /**
   * Handle successful sign-in and return authentication result
   * This also ensures that the provided person and account will available on the frontend with useAuth() (from this package)
   * This method should be used by any other package that implements authentication and wants to persist a successful login
   *
   * @param request - The incoming request
   * @param person - The authenticated person
   * @param account - The user account associated with the person
   * @returns A promise that resolves to an authentication result and tokens
   */
  static async onSigninSuccessful(
    provider: BackendProvider,
    person: UserData,
    account: UserAccountData,
    isNewAccount: boolean = false
  ): Promise<AuthenticationResult> {
    console.log(
      'Successful sign-in, sending back to frontend. Person: ' +
        person.id +
        ' Account: ' +
        account.id
    );
    const request: Request & { linkedAuth: AuthSession } = provider.request;

    try {
      const authentication = await Auth.buildAuthSession(
        provider,
        person,
        account,
        isNewAccount
      );

      // create the access token and a stored refresh token (a new session)
      const { accessToken, refreshToken, sessionId, refreshTokenExpiresAt } =
        await createToken(authentication);

      // set authentication to the request, remembering the session for updateSessionData
      Auth.setAuthentication(request, { ...authentication, sid: sessionId });

      // Set the httpOnly cookies; the refresh token stays in the body only for native clients.
      return deliverTokens(
        request,
        (provider as any).response,
        {
          auth: authentication,
          accessToken,
          refreshToken,
          // the server's lifetimes are not visible on the client: say when the session ends
          ...refreshTokenExpiryFields(refreshTokenExpiresAt),
        },
        { refreshTokenExpiresAt }
      ) as AuthenticationResult;
    } catch (err) {
      console.error('Failed to create token', err);
      throw err;
    }
  }

  /**
   * Build the AuthSession for a person + account, giving the app's backend providers the chance
   * to add their data (`initialAuthSession`, and `extendAuthSession` for existing accounts).
   * Used at sign-in and when a refresh token is exchanged for a new access token.
   */
  static async buildAuthSession(
    provider: BackendProvider,
    person: UserData,
    account: UserAccountData,
    isNewAccount: boolean = false
  ): Promise<AuthSession> {
    const server = provider.lincdServer;
    const authentication: AuthSession = {
      userAccount: account,
      user: person,
    };

    //Give the app its backend provider a chance to extend the authentication data with the default user and account data
    //NOTE: this will be things like false/undefined values for extra properties that are not set yet
    await server.callGenericBackendProvidersMethod(
      'initialAuthSession',
      authentication
    );
    //if this is not a new account, then it makes sense to allow backend providers
    // to actually extend the authentication session.
    //(if it IS a new account, we can just save the extra query and rely on the default values)
    if (!isNewAccount) {
      await server.callGenericBackendProvidersMethod(
        'extendAuthSession',
        authentication
      );
    }
    return authentication;
  }

  /**
   * Make `authentication` the session of `request` (when there is one) and of the query context.
   * Without a request (a call outside an HTTP request) only the query context is set, and
   * `updateSessionData` works on the returned object.
   */
  static setAuthentication(
    request: (Request & { linkedAuth: AuthSession }) | undefined,
    authentication: AuthSession
  ): AuthSession {
    const updateSessionData = async (
      updatedData: AuthSession
    ): Promise<
      {
        auth: AuthSession;
        accessToken: string;
        /** Only for native clients (body transport); browsers get it as an httpOnly cookie. */
        refreshToken?: string;
      } & RefreshTokenExpiry
    > => {
      const current: AuthSession = request?.linkedAuth ?? linkedAuth;

      // create completely new user and userAccount objects to avoid reference issues
      const updatedUser = {
        ...current.user,
        ...updatedData.user,
      };

      const updatedUserAccount = {
        ...current.userAccount,
        ...updatedData.userAccount,
      };

      // make sure accountOf sync with new user data
      // updatedUserAccount.accountOf = updatedUser;

      // the session (refresh token family) the current access token belongs to, if any
      const currentSessionId: string | undefined = current.sid;

      // create a new auth session object
      const newAuthSession: AuthSession = {
        user: updatedUser,
        userAccount: updatedUserAccount,
        updateSessionData, // Keep the reference to this function
        sid: currentSessionId,
      };

      // Update request.linkedAuth to point to the new session
      if (request) request.linkedAuth = newAuthSession;
      linkedAuth = newAuthSession;

      // Set query context for user and userAccount
      setQueryContext('user', updatedUser, Person);
      setQueryContext('userAccount', updatedUserAccount, UserAccount);

      // Same session: a new access token, and the client keeps its refresh token. Rotating the
      // refresh token here would revoke the one the client holds as a side effect of a profile
      // update. A token from before sessions existed has no `sid`: start a session for it.
      let accessToken: string;
      let refreshToken: string;
      let refreshTokenExpiresAt: Date | undefined;
      if (currentSessionId) {
        accessToken = await createAccessToken(
          newAuthSession,
          undefined,
          currentSessionId
        );
        // only sent to the auth endpoints (cookie path), so usually absent here
        refreshToken = (request as any)?.cookies?.refreshToken;
        if (refreshToken) {
          refreshTokenExpiresAt = await findRefreshTokenExpiry(refreshToken);
        }
      } else {
        let sessionId: string;
        ({ accessToken, refreshToken, sessionId, refreshTokenExpiresAt } =
          await createToken(newAuthSession));
        newAuthSession.sid = sessionId;
      }

      // The new access token replaces the cookie as well, so a reload renders the updated
      // session. The refresh cookie is only (re)set when a new session was started.
      return deliverTokens(
        request,
        (request as any)?.res,
        {
          auth: {
            user: newAuthSession.user,
            userAccount: newAuthSession.userAccount,
          },
          accessToken,
          refreshToken,
          ...refreshTokenExpiryFields(refreshTokenExpiresAt),
        },
        { refreshTokenExpiresAt, newRefreshToken: !currentSessionId }
      );
    };

    let linkedAuth: AuthSession = {
      ...authentication,
      updateSessionData,
    };

    if (request) request.linkedAuth = linkedAuth;

    // Set query context for user and userAccount
    setQueryContext('user', linkedAuth.user, Person);
    setQueryContext('userAccount', linkedAuth.userAccount, UserAccount);

    // console.log(`setAuthentication:`, {
    //   "linkedAuth.user": linkedAuth.user,
    //   "linkedAuth.userAccount": linkedAuth.userAccount,
    // });
    return linkedAuth;
  }
}
