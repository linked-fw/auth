import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import { auth } from '../ontologies/auth.js';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { Server } from '@_linked/server-utils/utils/Server';
import { QResult } from '@_linked/core/queries/SelectQuery';
import { Person } from '@_linked/schema/shapes/Person';
import { literalProperty, objectProperty } from '@_linked/core/shapes/SHACL';
import { xsd } from '@_linked/core/ontologies/xsd';

@linkedShape
export class AuthCredential extends Shape {
  static targetClass = auth.AuthCredential;

  @objectProperty({
    path: auth.credentialOf,
    shape: Person,
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

  /**
   * The SHA-256 hash (base64url) of the outstanding password reset token, if there is one. The
   * raw token only exists in the emailed link. Issuing a new link replaces it, and redeeming it
   * (or changing the password) removes it.
   */
  @literalProperty({
    path: auth.forgotPasswordToken,
    maxCount: 1,
  })
  get forgotPasswordToken(): string {
    return '';
  }

  /** When the outstanding password reset token stops working. A token without one never works. */
  @literalProperty({
    path: auth.forgotPasswordTokenExpiresAt,
    datatype: xsd.dateTime,
    maxCount: 1,
  })
  get forgotPasswordTokenExpiresAt(): Date {
    return undefined as any;
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

  /** Whether the signed-in user has a password; false for an OAuth-only account. */
  static userHasPassword(): Promise<boolean> {
    return Server.call(this, 'userHasPassword');
  }

  static createNewCredential(
    email: string,
    password: string,
    user: QResult<Person>
  ): Promise<QResult<AuthCredential>> {
    return Server.call(this, 'createNewCredential', email, password, user);
  }
}
