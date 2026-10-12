import { ShapeProvider } from '@_linked/server-utils/utils/ShapeProvider';
import { declareCallable, declareInternal } from '@_linked/server-utils/utils/callable';
import { AuthCredential } from './AuthCredential.js';
import PasswordHelper from '../helpers/password.js';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { Person } from '@_linked/schema/shapes/Person';
import { limitRequest } from '../utils/rateLimit.js';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';

// Outside the class: every provider method can be dispatched over HTTP.
async function credentialExists(person: QResult<Person>) {
  const credential = await AuthCredential.select()
    .where((p) => p.credentialOf.equals(person))
    .one();
  return credential && true;
}

export class AuthCredentialProvider extends ShapeProvider {
  public shape = AuthCredential;

  /**
   * Returns true if the user has a password stored in the database
   * That means, they are able to login with email and password
   */
  async userHasAuthCredential() {
    const user: QResult<Person> = this.request?.linkedAuth?.user;
    if (!user) {
      console.warn('No user authenticated');
      return false;
    }
    return credentialExists(user);
  }
  /**
   * Whether the signed-in user has a password (a stored password hash), so email/password
   * sign-in works for them. Unlike `userHasAuthCredential`, an OAuth-only account, whose
   * credential row has no hash, answers false.
   */
  async userHasPassword() {
    const user: QResult<Person> = this.request?.linkedAuth?.user;
    if (!user?.id) return false;
    const credentials = await AuthCredential.select((cred) => [cred.passwordHash]).where(
      (cred) => cred.credentialOf.equals({ id: user.id })
    );
    return (credentials || []).some((credential) => Boolean(credential.passwordHash));
  }

  /**
   * Whether `person` has a credential. Internal (backend code only): it answers for any person.
   * It is also limited by address, and a limited call fails with status 429.
   */
  async hasAuthCredential(person: QResult<Person>) {
    const limited = await limitRequest('credentialLookup', this.request, this.response);
    if (limited) throw new ServerCallError(429, limited.error);
    return credentialExists(person);
  }

  /**
   * Create a new password for the user
   *
   * @param password
   * @param user
   * @returns
   */
  async createNewCredential(email, password: string, user: QResult<Person>) {
    if (!password || !(typeof password === 'string')) {
      throw new Error('Password must be a string');
    }
    const passwordHash = await PasswordHelper.generateHashedPassword(password);

    const credential = await AuthCredential.create({
      credentialOf: user,
      email: email,
      passwordHash: passwordHash,
    });

    return credential;
  }
}

/**
 * The RPC surface of this provider (`/call/@_linked/auth/<AuthCredential shape>/<method>`).
 * `userHasAuthCredential` and `userHasPassword` answer for the signed-in user only.
 */
declareCallable(AuthCredentialProvider, {
  userHasAuthCredential: 'user',
  userHasPassword: 'user',
});

/**
 * Never dispatched over HTTP. `createNewCredential` adds a password to any person the caller
 * names; `resetPassword` reaches it through `AuthCredential.createNewCredential`, a
 * backend-to-backend call, which this does not affect. `hasAuthCredential` tells whether any
 * person has a credential (account enumeration); a client asks about the signed-in user with
 * `userHasAuthCredential` / `userHasPassword` instead.
 */
declareInternal(AuthCredentialProvider, ['createNewCredential', 'hasAuthCredential']);
