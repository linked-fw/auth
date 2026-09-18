import { Person as FoafPerson } from 'foaf/shapes/Person';
import { Person as SchemaPerson } from '@_linked/schema/shapes/Person';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import session from 'express-session';

import { Auth } from './utils/auth.js';
import { SendMailClient } from 'zeptomail';
import { AuthCredential } from './shapes/AuthCredential.js';
import { auth } from './ontologies/auth.js';
import { expressjwt, Request } from 'express-jwt';
import cookieParser from 'cookie-parser';
import type {
  AuthSessionPayload,
  AuthenticationResult,
  AppleOAuthPayload,
  CreateAccount,
  FacebookOAuthPayload,
  GoogleOAuthPayload,
  OAuthProvider,
  OAuthPayloadMap,
  OAuthProfilePayload,
  UserAccountData,
  UserData,
} from './types/auth.js';
import { createToken, verifyToken } from './utils/jwt.js';
import { RefreshToken } from './shapes/RefreshToken.js';
import {
  emitAccountWillBeRemovedEvent,
  onAccountWillBeRemoved,
} from './utils/events.js';
import AppleHelper, { buildAppleTokenAudiences } from './helpers/apple.js';
import FacebookHelper from './helpers/facebook.js';
import GoogleHelper from './helpers/google.js';
import {
  resolveOAuthAccountInput,
  resolveVerifiedEmailAccount,
} from './helpers/oauth-account.js';
import { buildOAuthSubjectLinkId } from './helpers/oauth-subject-link.js';
import PasswordHelper from './helpers/password.js';
import { IdentityToken } from './shapes/IdentityToken.js';
import path, { dirname, basename } from 'path';
import crypto from 'node:crypto';
import { LinkedEmail } from '@_linked/server-utils/utils/LinkedEmail';
import { QResult } from '@_linked/core/queries/SelectQuery';
import type { AuthSession } from './types/auth.js';

import connect_sqlite3 from 'connect-sqlite3';
import { emailToWebID } from './utils/webID.js';

var SQLiteStore = connect_sqlite3(session);

declare var process;
type Person = FoafPerson | SchemaPerson;

export * from './shapes/AuthCredentialProvider.js';

const filename__ =
  typeof __filename !== 'undefined'
    ? __filename
    : //@ts-ignore
      basename(import.meta.url).replace('file:/', '');

export default class AuthBackendProvider extends BackendProvider {
  public accountShape: typeof UserAccount = UserAccount;
  public userShape: typeof SchemaPerson = SchemaPerson;
  protected zeptoMail: SendMailClient;
  // Plan-011 — store the unsubscribe function so dispose() can detach the
  // listener without having to keep the original callback reference around.
  private unsubscribeAccountRemoval?: () => void;

  async setupBeforeControllers() {
    //if defined, take the values from the environment variables to define the shapes for the account and user
    await this.assignEnvPathToField('AUTH_ACCOUNT_TYPE', 'accountShape');
    await this.assignEnvPathToField('AUTH_USER_TYPE', 'userShape');

    this.unsubscribeAccountRemoval = onAccountWillBeRemoved(
      async (account: UserAccountData) => {
        // Delete by relation instead of selecting IDs first. Besides using one
        // mutation, this also handles legacy rows whose projected ID is missing.
        // IdentityToken is defined here in Auth, so its cleanup belongs in this
        // listener rather than in a dependent package's listener (moved from
        // PeaceGame's listener for correct ownership).
        await Promise.all([
          RefreshToken.deleteWhere((rt) => rt.account.equals(account)),
          IdentityToken.deleteWhere((token) => token.account.equals(account)),
        ]);
      }
    );

    // set the user and account shapes for auth
    Auth.userType = this.userShape;
    Auth.accountType = this.accountShape;

    // set zeptoMail client
    this.zeptoMail = new SendMailClient({
      url: 'api.zeptomail.com/',
      token: process.env.ZEPTOMAIL_TOKEN,
    });

    // FOR initial page requests we send the JWT token as a cookie (Stored in the browser)
    // see getToken for how we use the cookie and set this.request.linkedAuth
    // registerRoute tracks these so dispose() can remove them on HMR.
    this.registerRoute('use', '/', cookieParser());

    // For API requests, we send a token as the Bearer header
    // It gets parsed by this middleware and the result is that
    // on getToken we catch first every request and check the headers or cookies
    // and if has, we set into this.request.linkedAuth
    this.registerRoute(
      'use',
      '/',
      expressjwt({
        secret: process.env.JWT_SECRET || 'jwt-secret', // need to set this environment variable
        algorithms: ['HS256'],
        credentialsRequired: false, // allows unauthenticated requests to pass through
        getToken: async (
          req: Request & { auth: AuthSessionPayload } & {
            linkedAuth: AuthSession;
          }
        ): Promise<string> => {
          return this.validateRequestToken(req);
        },
        // called only when exp has passed
        onExpired: async (req, err) => {
          // …issue a new token or just keep going
          // req.auth will be undefined, so unauthenticated routes still work
          await this.validateRequestToken(req, true);
        },
      }).unless({
        // Skip token verification for all static assets
        path: [
          /^\/public\/.*/, // anything under /public
          /^\/uploads\/.*/, // anything under /uploads
          /^\/resized\/.*/, // dynamically‑resized images
          /^\/favicon\.ico$/, // favicon
          /^\/\.well-known\/.*/, // ACME challenges etc.
        ],
      })
    );

    let secret;
    if (process.env.SESSION_SECRET) {
      secret = process.env.SESSION_SECRET;
    } else {
      if (process.env.NODE_ENV !== 'development') {
        console.warn(
          'Please set the environment variable SESSION_SECRET\n' +
            'This is to ensure the sessions of this app are securely stored.\n' +
            'Preferably use a string of mixed characters. If this is a LINCD app, you can add the SESSION_SECRET to `.env-cmdrc.json`.\n' +
            'For now a less secure fallback method will be used.\n' +
            'See also https://www.npmjs.com/package/express-session#secret and https://www.npmjs.com/package/cookie-session#secret\n'
        );
      }
      secret = crypto.createHash('md5').update(filename__).digest('hex');
    }

    this.registerRoute(
      'use',
      '/',
      session({
        secret: secret,
        name: '@_linked/auth',
        //TODO: this broke sessions in production, need to check what else we need to do to make secure sessions work
        // cookie: {secure: process.env.NODE_ENV === 'production'},
        resave: true,
        saveUninitialized: false,
        store: new SQLiteStore({
          dir: path.join(process.cwd(), 'data'),
        }),
      })
    );
  }

  async dispose() {
    // Plan-011 — remove the middleware we tracked above + unsubscribe
    // the account-removed listener so HMR doesn't leak handlers.
    this.disposeRoutes();
    this.unsubscribeAccountRemoval?.();
    this.unsubscribeAccountRemoval = undefined;
  }

  async validateRequestToken(request, accessTokenExpired: boolean = false) {
    // get the token from request headers or cookies
    let token = this.getTokenFromRequest(request);
    let refreshToken = this.getRefreshTokenFromRequest(request);

    // if token is found, validate it
    if (token) {
      const verificationResult = await verifyToken({
        request,
        token,
        refreshToken,
        provider: this,
        accessTokenExpired,
      });

      // if token is valid, set the authentication object
      if (verificationResult) {
        let authentication = await Auth.setAuthentication(
          request as any,
          verificationResult.payload
        );

        if (!authentication) {
          console.log(`GET TOKEN authentication: no authentication`);
          return null;
        }

        return verificationResult.accessToken;
      }
    }

    return null;
  }

  /**
   * Initialize the incoming request
   *
   * @param request - The incoming request
   * @param response - The outgoing response
   */
  async initRequest(request, response) {
    super.initRequest(request, response);
  }

  // TODO: check possible to remove this method?
  checkSignin() {
    //this is a temporary fix that allows the frontend to check if the user is still logged in on the backend
    return this.request.linkedAuth?.userAccount;
  }

  /**
   * Supply data for the incoming request
   * This data will then be available on the frontend right upon initialisation
   *
   * @param request - The incoming request
   * @param response - The outgoing response
   * @param dataQuads - The set of data quads to be populated
   */
  async supplyDataForRequest(request, response, dataQuads: any): Promise<void> {
    //if logged in and we're collecting frontend data
    if (request.linkedAuth && request.frontendData) {
      const requestAuth = { ...request.linkedAuth };
      //Remove things that should not go to the frontend
      delete requestAuth.updateSessionData;
      //Store in the object that will be sent to the frontend
      request.frontendData.auth = requestAuth;
    }
  }

  /**
   * Sign in with email and password
   *
   * @param email - The email address
   * @param plainPassword - The plain password
   * @returns
   */
  async signinWithPassword(
    email: string,
    plainPassword: string
  ): Promise<AuthenticationResult> {
    let webID: string;
    try {
      webID = emailToWebID(email);
    } catch (error) {
      console.error(`Invalid email format during signin: ${email}`, error);
      return {
        error: 'Invalid email format',
      };
    }

    // find any passwords for accounts with this email
    // and select the hash and account/person details
    let existingCredential = await this.getPasswordForUser({ id: webID });

    if (!existingCredential) {
      console.warn(
        `Could not find any password associated with this email: ${email}, so we will check by user email`
      );

      // we get the user by email, if catch the user from here
      // we can say the user signup with temporary signin
      const account = await UserAccount.select((ua) => {
        return [ua.email, ua.accountOf];
      })
        .where((ua) => {
          return ua.email.equals(email);
        })
        .one();

      if (!account) {
        return {
          error: 'This email is not registered',
        };
      }

      const accountCredentials = await AuthCredential.select((ac) => {
        return [
          ac.passwordHash,
          ac.credentialOf.select((p) => {
            return [p.givenName, p.familyName, p.telephone];
          }),
        ];
      }).where((ac) => {
        return ac.credentialOf.equals({ id: account.accountOf.id });
      });

      // OAuth and legacy flows can leave more than one credential row on a
      // person. Select the row that actually contains a password hash.
      existingCredential = accountCredentials.find((credential) =>
        Boolean(credential.passwordHash)
      );

      if (!existingCredential) {
        return {
          error: 'No password found for this email',
        };
      }
    }

    const passwordIsValid = await PasswordHelper.checkPassword(
      plainPassword,
      existingCredential.passwordHash
    );

    if (!passwordIsValid) {
      return {
        error: 'Invalid email / password combination',
      };
    }

    const person = existingCredential.credentialOf;

    const account = await this.getOrCreateAccount(person);

    return Auth.onSigninSuccessful(this, person, account);
  }

  /**
   * Create a new account
   *
   * @param CreateAccount - The account data to create
   * @returns
   */
  async createAccount({
    firstName,
    lastName,
    email,
    password,
  }: CreateAccount): Promise<AuthenticationResult> {
    // check if the first name and email are provided
    if (!firstName || !email) {
      return {
        error: 'No first name or email are provided',
      };
    }

    let webIDFromEmail: string;
    try {
      webIDFromEmail = emailToWebID(email);
    } catch (error) {
      console.error(
        `Invalid email format during account creation: ${email}`,
        error
      );
      return {
        error: 'Invalid email format',
      };
    }

    //check if this user has already been created/stored locally
    let existingWebID = await (this.userShape as any)
      .select((p) => [p.givenName, p.familyName, p.telephone])
      .for(webIDFromEmail);
    if (existingWebID) {
      console.warn(
        `Account creation attempted with existing email: ${email} (webID: ${webIDFromEmail})`
      );
      return {
        error:
          'This email address is already in use. Please choose another email or log in with your existing account.',
        action: 'change_email_or_log_in',
      };
    }

    return Auth.login(
      this,
      async () => {
        //we're not trying to log in with an existing account, a new one should be created
        return null;
      },
      async () => {
        //Create a user and a new new account.
        //NOTE: the user URI is now the webID of their profile.
        //And the webID is generated from their email (OR phonenumber)
        const user = await (this.userShape as any)
          .create({
            __id: webIDFromEmail,
            givenName: firstName,
            familyName: lastName,
            telephone: '',
          })
          .catch((err) => {
            console.error(
              `Error creating user ${firstName} ${lastName} - ${email}:`,
              err
            );
            throw new Error(
              `Could not create user ${firstName} ${lastName} - ${email}`
            );
          });

        // generate a new login credential for the user
        const passwordHash = await PasswordHelper.generateHashedPassword(
          password
        );
        const newCredential = await AuthCredential.create({
          credentialOf: {
            id: user.id,
          },
          passwordHash: passwordHash,
        }).catch((err) => {
          console.error(`Error creating password for user ${user.id}:`, err);
          throw new Error(`Could not create password for user ${user.id}`);
        });
        console.log(`created new password for ${user.id}`);

        //create a new account
        const account = await this.accountShape
          .create({
            accountOf: user,
            email: email,
          })
          .catch((err) => {
            console.error(`Error creating account for user ${user.id}:`, err);
            throw new Error(`Could not create account for user ${user.id}`);
          });

        console.log(`new user:`, JSON.stringify(user));
        console.log(`new account:`, JSON.stringify(account));

        return {
          account: account,
          person: user,
        };
      },
      `createAccount - ${firstName} ${lastName} - ${email}`
    );
  }

  /**
   * Get the password (AuthCredential) for a user
   *
   * @param user - The user
   * @returns The password (AuthCredential)
   */
  async getPasswordForUser(user: QResult<Person>) {
    const credentials = await AuthCredential.select((cred) => {
      return [
        cred.passwordHash,
        cred.credentialOf.select((p) => {
          return [p.givenName, p.familyName, p.telephone];
        }),
      ];
    }).where((cred) => {
      return cred.credentialOf.equals({ id: user.id });
    });

    const credential = credentials.find((candidate) =>
      Boolean(candidate.passwordHash)
    );

    if (!credential) {
      console.warn(`Could not find any password for account ${user.id}`);
      return null;
    }

    return credential;
  }
  /**
   * Reset the password
   *
   * @param password - The new password
   * @param confirmPassword - The confirmed password
   * @param token - The reset password token
   * @returns
   */
  async resetPassword(
    password: string,
    confirmPassword: string,
    token: string
  ): Promise<AuthenticationResult> {
    // check if password and confirmPassword match
    if (password !== confirmPassword) {
      return {
        error: 'Passwords do not match',
      };
    }

    //reset password works both if a token is provided, and if a user is currently logged in
    const user: QResult<Person> = token
      ? await PasswordHelper.validateResetPasswordToken(token)
      : this.request?.linkedAuth?.user;

    if (!user) {
      console.warn('No user account found to reset password');
      return {
        error: 'No user account found to reset password',
      };
    }

    //find or create the account of the user
    const account = await this.getOrCreateAccount(user);

    // Phase 1.1: WebID is one-way (UUID v5 of email). Recover email by
    // looking up UserAccount.email keyed on the WebID rather than reversing.
    const emailLookup = await UserAccount.select((ua) => [ua.email])
      .where((ua) => ua.accountOf.equals({ id: user.id } as any))
      .one()
      .catch(() => null);
    const email = (emailLookup as any)?.email ?? null;

    if (!email) {
      console.warn(
        `Could not look up email for webID during password reset: ${user.id}`
      );
      return {
        error: 'Could not determine email address from user account',
      };
    }

    // get the password from the database
    const dbPassword = await this.getPasswordForUser(user);

    // if no password found, create a new one
    if (!dbPassword) {
      console.warn(
        'Password not found for this account : ' +
          user.id +
          'creating one in order to reset password'
      );
      await AuthCredential.createNewCredential(email, password, user);
    } else {
      // update existing password
      const newHashedPassword = await PasswordHelper.generateHashedPassword(
        password
      );

      await AuthCredential.update({
        passwordHash: newHashedPassword,
      }).for(dbPassword);
    }

    const person = user;
    return Auth.onSigninSuccessful(this, person, account);
  }

  async getOrCreateAccount(user: QResult<Person>) {
    //get or create account
    let account = await this.accountShape
      .select((a) => a.accountOf)
      .where((a) => a.accountOf.equals({ id: user.id }))
      .one();
    if (!account) {
      //accounts can be created on the fly,
      // it means this user/webID existed, but it's the first time they log in here to this app
      // use account.profileSetupComplete or similar if you want to direct the user to a profile setup page
      account = await this.accountShape.create({
        accountOf: {
          id: user.id,
        },
      });
    }
    return account;
  }

  /**
   * Send the reset password link with zeptoMail
   *
   * @param email - The email address
   * @returns
   */
  async sendResetPasswordLink(email: string) {
    const newToken = PasswordHelper.generateToken();
    const normalizedEmail = email.toLowerCase();
    let webID: string;
    try {
      webID = emailToWebID(normalizedEmail);
    } catch (error) {
      console.error(
        `Invalid email format during password reset request: ${email}`,
        error
      );
      return {
        error: 'Invalid email format',
      };
    }

    const existingCredential = await this.getPasswordForUser({ id: webID });

    if (!existingCredential) {
      const account = await UserAccount.select((ua) => {
        return [
          ua.email,
          ua.accountOf.select((p) => {
            return [p.givenName, p.telephone];
          }),
        ];
      })
        .where((ua) => {
          return ua.email.equals(normalizedEmail);
        })
        .one();

      if (!account?.accountOf?.id) {
        console.warn(`No account found for reset password email ${email}`);
        return {
          error:
            'No password is associated with this account. Please try another login method or contact support.',
        };
      }

      webID = account.accountOf.id;
      await AuthCredential.create({
        credentialOf: {
          id: webID,
        },
        email: normalizedEmail,
        telephone: account.accountOf.telephone || undefined,
        forgotPasswordToken: newToken,
      });
    } else {
      await AuthCredential.update({
        forgotPasswordToken: newToken,
      }).for(existingCredential);
    }

    const person = await this.userShape
      .select((u) => u.givenName)
      .for({ id: webID })
      .one();

    if (!person) {
      console.warn(`No user found for reset password webID ${webID}`);
      return {
        error: 'We could not prepare the reset password link for this account.',
      };
    }

    const confirmUrl = `${process.env.SITE_ROOT}/auth/reset-password?token=${newToken}`;

    const emailOptions = {
      to: [
        {
          email_address: {
            address: email, // destination
            name: normalizedEmail, // recipient Name
          },
        },
      ],
      subject: `Reset Your ${process.env.APP_NAME} Password`,
      htmlbody: `
          <table role='presentation' border='0' cellpadding='0' cellspacing='0' class='body' style='border-collapse: separate; mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #fff; width: 100%;' width='100%' bgcolor='#fff'>
            <tr>
              <td>
                <p>Hey ${person.givenName} 👋</p>
                <p>Click the button below to reset your password:</p>
                <a href='${confirmUrl}' target='_blank' style='border: solid 1px #3498db; border-radius: 5px; box-sizing: border-box; cursor: pointer; display: inline-block; font-size: 14px; font-weight: bold; margin: 0; padding: 12px 25px; text-decoration: none; text-transform: capitalize; background-color: #3498db; border-color: #3498db; color: #ffffff;'>Reset Password</a>
                <p>Cheers,</p>
                <p>${process.env.APP_NAME} Team</p>
              </td>
            </tr>
            <tr>
              <td>
                <p style='font-size: 12px; color: #999;'>Alternatively, you can also copy and paste the link into your browser:</p>
                <a href='${confirmUrl}' target='_blank' style='font-size: 12px;'>${confirmUrl}</a>
              </td>
            </tr>
          </table>
        `,
    };

    // await this.zeptoMail.sendMail(emailOptions);
    return LinkedEmail.send(emailOptions)
      .then(() => {
        return true;
      })
      .catch((error) => {
        console.error('Error sending reset link:', error);
        return {
          error: "Sorry, we couldn't send the email, please try again later",
        };
      });
  }

  /**
   * Sign in with OAuth provider
   *
   * @param provider - The OAuth provider
   * @param oauthUserData
   * @returns
   */
  async signinOAuth<Provider extends OAuthProvider>(
    provider: Provider,
    oauthUserData: OAuthPayloadMap[Provider]
  ): Promise<AuthenticationResult> {
    let { email, name, familyName, givenName, imageUrl } =
      oauthUserData as OAuthProfilePayload;
    let identityToken: string | undefined;
    let appleSubject: string | undefined;
    let subjectAccount: UserAccountData | undefined;

    if (provider === 'apple') {
      const appleData = oauthUserData as AppleOAuthPayload;
      identityToken = appleData.identityToken;
      let appleIdentity;
      try {
        appleIdentity = await AppleHelper.validateIdentityToken(
          identityToken,
          {
            nonce: appleData.nonce,
            audiences: buildAppleTokenAudiences(
              process.env.APP_ID,
              process.env.APPLE_SIGN_IN_CLIENT_ID,
              process.env.APPLE_IOS_BUNDLE_ID
            ),
          }
        );
      } catch (error) {
        console.error('Apple OAuth validation failed');
        return { error: 'Invalid Apple identity token' };
      }

      email = appleIdentity.email;
      appleSubject = appleIdentity.sub;
      try {
        const subjectTokens = await IdentityToken.getTokensBySubject(
          appleSubject
        );
        const resolution = resolveOAuthAccountInput({
          provider,
          verifiedEmail: email,
          subjectCandidates: subjectTokens.map((token) => ({
            account: token.account,
            email: token.email,
          })),
        });
        if ('error' in resolution) return { error: resolution.error };
        if ('account' in resolution) subjectAccount = resolution.account;
        email = resolution.email;
      } catch (error) {
        console.error('Apple account resolution failed', error);
        return {
          error: 'Apple sign-in is temporarily unavailable. Please try again.',
        };
      }
    }

    if (provider === 'google') {
      const googleData = oauthUserData as GoogleOAuthPayload;
      const idToken = googleData.authentication?.idToken;
      if (!idToken) {
        console.error('Google OAuth: No ID token provided');
        return { error: 'No Google ID token provided' };
      }

      const googlePayload = await GoogleHelper.validateIdToken(idToken);
      if (!googlePayload) {
        console.error('Google OAuth: Invalid ID token');
        return { error: 'Invalid Google ID token' };
      }

      // Extract user data from validated Google payload
      email = googlePayload.email;
      name = googlePayload.name;
      givenName = googlePayload.given_name;
      familyName = googlePayload.family_name;
      imageUrl = googlePayload.picture;
    }

    if (provider === 'facebook') {
      const facebookData = oauthUserData as FacebookOAuthPayload;
      try {
        const facebookIdentity = await FacebookHelper.validateAccessToken(
          facebookData.accessToken
        );
        email = facebookIdentity.email;
        name = facebookIdentity.name;
        givenName = facebookIdentity.givenName;
        familyName = facebookIdentity.familyName;
        imageUrl = facebookIdentity.imageUrl;
      } catch (error) {
        console.error('Facebook OAuth validation failed');
        return { error: 'Invalid Facebook access token' };
      }
    }

    // Apple generally returns email only on first consent. A verified subject
    // link is therefore authoritative for repeat login.
    if (!email) {
      console.log('No verified email provided to signinOAuth:', provider);
      return { error: 'could not find email in OAuth response' };
    }

    email = String(email).trim().toLowerCase();

    let expectedWebID: string | undefined;
    let verifiedEmailAccount: UserAccountData | undefined;
    if (!subjectAccount) {
      try {
        expectedWebID = emailToWebID(email);
      } catch (error) {
        console.error(
          `Invalid email format during OAuth signin: ${email}`,
          error
        );
        return { error: 'Invalid email format' };
      }

      const emailAccounts = await this.accountShape
        .select((account) => [
          account.email,
          account.accountOf.select((person) => [
            person.givenName,
            person.familyName,
            person.telephone,
          ]),
        ])
        .where((account) => account.email.equals(email));
      const emailResolution = resolveVerifiedEmailAccount(emailAccounts);
      if (emailResolution.error) return { error: emailResolution.error };
      verifiedEmailAccount = emailResolution.account;
    }

    const createAppleIdentityLink = async (account: UserAccountData) => {
      if (provider !== 'apple' || !appleSubject) return;
      await IdentityToken.create({
        __id: buildOAuthSubjectLinkId(
          process.env.DATA_ROOT,
          provider,
          appleSubject
        ),
        email,
        sub: appleSubject,
        account,
      } as any);
    };

    // use Auth.login pattern like createAccount for Google and other OAuth providers
    return Auth.login(
      this,
      async () => {
        if (subjectAccount) {
          return {
            account: subjectAccount,
            person: subjectAccount.accountOf,
          };
        }

        if (verifiedEmailAccount) {
          await createAppleIdentityLink(verifiedEmailAccount);
          return {
            account: verifiedEmailAccount,
            person: verifiedEmailAccount.accountOf,
          };
        }

        // before we create a new user and account, check if the user already exists
        // if exists, return the existing account and person so user can be signed in directly
        const webID = expectedWebID!;

        const existingAccount = await this.accountShape
          .select((a) => {
            return [
              a.email,
              a.accountOf.select((p) => [
                p.givenName,
                p.familyName,
                p.telephone,
              ]),
            ];
          })
          .where((a) => {
            return a.accountOf.equals({
              id: webID,
            });
          })
          .one();

        if (!existingAccount) {
          return null;
        }

        await createAppleIdentityLink(existingAccount);

        return {
          account: existingAccount,
          person: existingAccount.accountOf,
        };
      },
      async () => {
        // create new user and account
        const webID = expectedWebID!;

        // prepare user data based on the provider
        const userData = {
          __id: webID,
          givenName: givenName || '',
          familyName: familyName || '',
          telephone: '',
        };

        // create user
        const user = await (this.userShape as any)
          .create(userData)
          .catch((err) => {
            console.error(`Error creating ${provider} user - ${email}:`, err);
            throw new Error(`Could not create ${provider} user - ${email}`);
          });

        // Create AuthCredential for OAuth user (no password needed)
        const newCredential = await AuthCredential.create({
          credentialOf: {
            id: user.id,
          },
          email: email,
          // No passwordHash for OAuth users
        }).catch((err) => {
          console.error(
            `Error creating credential for ${provider} user ${user.id}:`,
            err
          );
          throw new Error(
            `Could not create credential for ${provider} user ${user.id}`
          );
        });
        console.log(`created new credential for ${user.id}`);

        // Create account
        const accountData: any = {
          accountOf: user,
          email: email,
        };

        // create account
        const account = await this.accountShape
          .create(accountData)
          .catch((err) => {
            console.error(
              `Error creating ${provider} account for user ${user.id}:`,
              err
            );
            throw new Error(
              `Could not create ${provider} account for user ${user.id}`
            );
          });

        // Save Apple IdentityToken if this is an Apple sign-in
        if (provider === 'apple' && identityToken && appleSubject) {
          await createAppleIdentityLink(account as UserAccountData).catch((err) => {
            console.error(
              `Error creating Apple IdentityToken for user ${user.id}:`,
              err
            );
            throw new Error(
              `Could not create Apple IdentityToken for user ${user.id}`
            );
          });
        }

        console.log(`${provider} user created:`, JSON.stringify(user));
        console.log(`${provider} account created:`, JSON.stringify(account));

        return {
          account: account as any,
          person: user as any,
        };
      },
      `${provider} - ${email}`
    );
  }

  /**
   * Temporary sign in without any credentials
   * TODO: how to make this support with WebID? since user doesn't have email
   *
   * Note: we not save AuthCredential for temporary user for now, you need to save it on different way. Example: on register form, etc..
   *
   * @returns
   */
  async signinTemporary() {
    const person = await (this.userShape as any)
      .create({
        givenName: '',
      })
      .catch((err) => {
        console.error('Error creating temporary user:', err);
        throw new Error('Error creating temporary user');
      });
    console.log(`Temporary person created: ${person.id}`);

    const account = await this.accountShape
      .create({
        accountOf: person,
      })
      .catch((err) => {
        console.error('Error creating temporary account:', err);
        throw new Error('Error creating temporary account');
      });
    console.log(`Temporary account created: ${account.id}`);

    account.accountOf = person;

    return await Auth.onSigninSuccessful(
      this,
      person,
      account as UserAccountData,
      true
    );
  }

  /**
   * Dev-mode webid.email sign-in. Counterpart of GET /auth/dev:
   * the iframe loaded from /auth/dev posts {webId, accessToken, refreshToken}
   * to the parent. The frontend forwards that payload here via Server.call.
   *
   * We trust the access token because we signed it ourselves moments ago
   * (DEV_AUTH=true path only — Phase 5.3 swaps in webid.email's JWT).
   *
   * After validating, find or create the Person + UserAccount, then return
   * the standard signin response shape. Workspace provisioning is done by
   * the frontend in a follow-up Server.call to avoid coupling @_linked/auth
   * to CN-specific shapes.
   */
  async signinDev(input: {
    webId: string;
    accessToken: string;
    refreshToken: string;
    email?: string;
  }) {
    // DEV_AUTH gate — tolerate either string 'true' or boolean true.
    // (env-cmd's spread-assign to process.env preserves boolean values.)
    const devAuth = process.env.DEV_AUTH as unknown;
    if (devAuth !== 'true' && devAuth !== true) {
      return { error: 'Dev signin disabled' };
    }
    const tokenResult = await verifyToken({
      request: this.request,
      token: input.accessToken,
      refreshToken: input.refreshToken,
      provider: this,
    });
    if (!tokenResult || (tokenResult as any).error) {
      return { error: (tokenResult as any)?.error ?? 'Invalid token' };
    }
    const claims = (tokenResult as any).payload ?? tokenResult;
    if (claims.sub && claims.sub !== input.webId) {
      return { error: 'WebID does not match token subject' };
    }
    const email = (claims.email as string | undefined) ?? input.email;

    // Dev signin doesn't persist a Person — the WebID profile is hosted by the
    // identity provider (e.g. webid.email). Plain identity data, never a live Shape.
    const person = { id: input.webId } as UserData;

    // Find or create the UserAccount for this Person/WebID.
    const account = await this.getOrCreateAccount(person);
    if (email && !(account as any).email) {
      try {
        await (this.accountShape as any).update({ email }).for(account);
      } catch (err) {
        console.warn('Could not set email on UserAccount:', err);
      }
    }

    return Auth.onSigninSuccessful(this, person, account as UserAccountData);
  }

  async removeAccount() {
    const auth = this.request.linkedAuth;
    if (!auth) {
      return null;
    }

    const account = auth.userAccount;
    const user = auth.user;

    // Cleanup listeners build relation filters from both nodes, so validate
    // them before emitting the event rather than only before final deletion.
    if (!account?.id || !user?.id) {
      throw new Error('Cannot remove account: account or user ID is missing.');
    }

    await emitAccountWillBeRemovedEvent(account);

    // Remove every credential for the user without relying on a projected ID.
    await AuthCredential.deleteWhere((credential) =>
      credential.credentialOf.equals(user)
    );

    //remove account and user
    await this.accountShape.delete({ id: account.id });
    await this.userShape.delete({ id: user.id });

    console.log('Account has been deleted', account.id);
    this.signout();

    return true;
  }

  /**
   * Sign out the user and remove the refresh token from the database
   *
   * @returns A promise that resolves to a boolean indicating the success of sign-out
   */
  async signout(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const auth = this.request.linkedAuth;
        if (!auth) {
          resolve(false);
          return;
        }

        resolve(true);
      } catch (err) {
        console.warn('error during signout: ', err.toString());
        reject(err);
      }
    });
  }

  /**
   * Validate the bearer token header and return the authentication result
   *
   * @param refreshToken - Optional refresh token
   * @returns A promise that resolves to an authentication result
   */
  async validateToken(refreshToken?: string): Promise<AuthenticationResult> {
    // get the token from request headers or cookies
    const request = this.request;
    let token = this.getTokenFromRequest(request);
    refreshToken = refreshToken || this.getRefreshTokenFromRequest(request);

    // if token is found, validate it
    if (token) {
      try {
        const verificationResult: any = await verifyToken({
          request,
          token,
          refreshToken,
          provider: this,
        });

        // if token is valid, set the authentication object
        // and return the payload with new access token and refresh token
        if (verificationResult) {
          const authentication = Auth.setAuthentication(
            request,
            verificationResult.payload
          );

          if (!authentication) {
            return {
              error: 'Invalid token',
            };
          }

          return {
            auth: authentication,
            accessToken: verificationResult.accessToken,
            refreshToken: verificationResult.refreshToken,
          };
        } else {
          // if token is invalid, return error
          return {
            error: 'Invalid token',
          };
        }
      } catch (err) {
        // error while decoding token
        return {
          error: 'Token decoding error',
        };
      }
    }

    // no token found in Authorization header or cookies
    return {
      error: 'No token found',
    };
  }

  /**
   * Gets the access token from the request.
   * This method checks the Authorization header for a Bearer token
   * or looks for a cookie named 'accessToken'.
   * @param req
   * @protected
   */
  protected getTokenFromRequest(req: Request) {
    if (
      req.headers.authorization &&
      req.headers.authorization.split(' ')[0] === 'Bearer'
    ) {
      return req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.accessToken) {
      return req.cookies.accessToken;
    }
    return null;
  }

  // get refresh token from request
  protected getRefreshTokenFromRequest(req: Request) {
    return req.cookies && req.cookies.refreshToken;
  }
}
