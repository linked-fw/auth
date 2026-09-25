import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { Person, Person as SchemaPerson } from '@_linked/schema/shapes/Person';
import { Person as FoafPerson } from 'foaf/shapes/Person';
import { Server } from '@_linked/server-utils/utils/Server';
import { ENFORCE_SIGNED_IN } from '../hooks/useAuth.js';
import type {
  AuthenticationResult,
  AuthSession,
  EnforceSignedIn,
  UserAccountData,
  UserData,
} from '../types/auth.js';
import { createToken } from './jwt.js';
import { RefreshToken } from '../shapes/RefreshToken.js';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { setQueryContext } from '@_linked/core/queries/QueryContext';

export class Auth {
  // define the default user and account types
  static userType: typeof SchemaPerson | typeof FoafPerson = SchemaPerson;
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
      person: QResult<SchemaPerson | FoafPerson>;
    }>,
    createAccount: () => Promise<{
      account: QResult<UserAccount>;
      person: QResult<SchemaPerson | FoafPerson>;
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
   * This also ensures that the provided person and account will available on the frontend with useAuth() (from lincd-auth)
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
    const server = provider.lincdServer;

    return new Promise(async (resolve, reject) => {
      try {
        // create authentication object
        let authentication: AuthSession = {
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

        // create JWT tokens for the person and account
        const { accessToken, refreshToken } = await createToken(authentication);

        //update: we don't need to save the token to the database, it only lives on the front-end
        // // save refresh token to database
        // if (refreshToken) {
        //   const token = await RefreshToken.create({
        //     token: refreshToken,
        //     account: account,
        //   });
        //   console.log(`token`, JSON.stringify(token));
        // }

        // set authentication to the request
        Auth.setAuthentication(request, authentication);

        resolve({
          auth: authentication,
          accessToken,
          refreshToken,
          // user: person,
          // userAccount: account,
        } as AuthenticationResult);
      } catch (err) {
        console.error('Failed to create token', err);
        reject(err);
      }
    });
  }

  static setAuthentication(
    request: Request & { linkedAuth: AuthSession },
    authentication: AuthSession
  ): AuthSession {
    const updateSessionData = async (
      updatedData: AuthSession
    ): Promise<{
      auth: AuthSession;
      accessToken: string;
      refreshToken: string;
    }> => {
      // create completely new user and userAccount objects to avoid reference issues
      const updatedUser = {
        ...request.linkedAuth.user,
        ...updatedData.user,
      };

      const updatedUserAccount = {
        ...request.linkedAuth.userAccount,
        ...updatedData.userAccount,
      };

      // make sure accountOf sync with new user data
      // updatedUserAccount.accountOf = updatedUser;

      // create a new auth session object
      const newAuthSession = {
        user: updatedUser,
        userAccount: updatedUserAccount,
        updateSessionData, // Keep the reference to this function
      };

      // Update request.linkedAuth to point to the new session
      request.linkedAuth = newAuthSession;

      // Set query context for user and userAccount
      setQueryContext('user', updatedUser, Person);
      setQueryContext('userAccount', updatedUserAccount, UserAccount);

      const { accessToken, refreshToken } = await createToken(
        request.linkedAuth
      );

      return {
        auth: {
          user: request.linkedAuth.user,
          userAccount: request.linkedAuth.userAccount,
        },
        accessToken,
        refreshToken,
      };
    };

    const linkedAuth = {
      ...authentication,
      updateSessionData,
    };

    request.linkedAuth = linkedAuth;

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
