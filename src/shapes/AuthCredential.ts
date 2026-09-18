import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import { auth } from '../ontologies/auth.js';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { Server } from '@_linked/server-utils/utils/Server';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { Person } from '@_linked/schema/shapes/Person';
import { literalProperty, objectProperty } from '@_linked/core/shapes/SHACL';

@linkedShape
export class AuthCredential extends Shape {
  static targetClass = auth.AuthCredential;

  @objectProperty({
    path: auth.credentialOf,
    shape: ['@_linked/schema', 'Person'],
    maxCount: 1,
  })
  get credentialOf(): Person {
    return undefined as any;
  }

  @literalProperty({
    path: auth.email,
    required: false,
    maxCount: 1,
  })
  get email(): string {
    return '';
  }

  @literalProperty({
    path: auth.forgotPasswordToken,
    maxCount: 1,
  })
  get forgotPasswordToken(): string {
    return '';
  }

  @literalProperty({
    path: auth.passwordHash,
    maxCount: 1,
  })
  get passwordHash(): string {
    return '';
  }

  @literalProperty({
    path: auth.telephone,
    required: false,
    maxCount: 1,
  })
  get telephone(): string {
    return '';
  }

  static userHasAuthCredential(): Promise<boolean> {
    return Server.call(this, 'userHasAuthCredential');
  }

  static hasAuthCredential(person: QResult<Person>): Promise<boolean> {
    return Server.call(this, 'hasAuthCredential', person);
  }

  /**
   * Returns true if the current signed-in user has an AuthCredential with a password hash.
   * Use this when the caller specifically needs to know whether email/password login is available.
   */
  static userHasPassword(): Promise<boolean> {
    return Server.call(this, 'userHasPassword');
  }

  /**
   * Returns true if the given person has an AuthCredential with a password hash.
   * This is narrower than hasAuthCredential(), which only checks whether any credential row exists.
   */
  static hasPassword(person: QResult<Person>): Promise<boolean> {
    return Server.call(this, 'hasPassword', person);
  }

  static createNewCredential(
    email: string,
    password: string,
    user: QResult<Person>
  ): Promise<QResult<AuthCredential>> {
    return Server.call(this, 'createNewCredential', email, password, user);
  }
}
