import { ShapeProvider } from '@_linked/server-utils/utils/ShapeProvider';
import { AuthCredential } from './AuthCredential.js';
import PasswordHelper from '../helpers/password.js';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { Person } from '@_linked/schema/shapes/Person';

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
    return this.hasAuthCredential(user);
  }
  async hasAuthCredential(person: QResult<Person>) {
    const credential = await AuthCredential.select()
      .where((p) => p.credentialOf.equals({ id: person.id }))
      .one();

    return credential && true;
  }

  /**
   * Returns true if the current signed-in user has a stored password hash.
   * This is the correct check for whether email/password login is available.
   */
  async userHasPassword() {
    const user: QResult<Person> = this.request?.linkedAuth?.user;
    if (!user) {
      console.warn('No user authenticated');
      return false;
    }
    return this.hasPassword(user);
  }

  /**
   * Returns true if the given person has an AuthCredential with a password hash.
   * This intentionally ignores credential rows created for OAuth-only users.
   */
  async hasPassword(person: QResult<Person>) {
    const credentials = await AuthCredential.select((cred) => {
      return [cred.passwordHash];
    }).where((cred) => cred.credentialOf.equals({ id: person.id }));

    return credentials.some((credential) => Boolean(credential.passwordHash));
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
