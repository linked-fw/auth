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

  /**
   * When the person proved control of `email`, by opening a verification or reset link sent to
   * it, or by signing in with a provider that verified it. A person counts as verified when any
   * of their credentials has it.
   */
  @literalProperty({
    path: auth.emailVerifiedAt,
    datatype: xsd.dateTime,
    maxCount: 1,
  })
  get emailVerifiedAt(): Date {
    return undefined as any;
  }

  /**
   * The SHA-256 hash (base64url) of the outstanding email verification token, if there is one.
   * The raw token only exists in the emailed link. Sending a new link replaces it, and verifying
   * the email removes it.
   */
  @literalProperty({
    path: auth.emailVerificationToken,
    maxCount: 1,
  })
  get emailVerificationToken(): string {
    return '';
  }

  /** When the outstanding email verification token stops working. */
  @literalProperty({
    path: auth.emailVerificationTokenExpiresAt,
    datatype: xsd.dateTime,
    maxCount: 1,
  })
  get emailVerificationTokenExpiresAt(): Date {
    return undefined as any;
  }

  /**
   * Set only for the moment between an atomic token consume and its read-back: the consume
   * writes a fresh random marker in the same update that removes the token, then looks for it.
   * Only the request whose update matched the token finds its marker. See `consumeCredentialToken`.
   */
  @literalProperty({
    path: auth.consumeMarker,
    maxCount: 1,
  })
  get consumeMarker(): string {
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
