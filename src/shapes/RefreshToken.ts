import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import { auth } from '../ontologies/auth.js';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { literalProperty, objectProperty } from '@_linked/core/shapes/SHACL';
import type { UserAccountData } from '../types/auth.js';

@linkedShape
export class RefreshToken extends Shape {
  static targetClass = auth.RefreshToken;

  @literalProperty({
    path: auth.token,
    maxCount: 1,
  })
  get token(): string {
    return '';
  }

  @objectProperty({
    path: auth.account,
    shape: ['@_linked/sioc', 'UserAccount'],
    maxCount: 1,
  })
  get account(): UserAccount {
    return undefined as any;
  }

  /**
   * Remove the token from the database
   *
   * @param token The token to remove
   * @returns True if the token was removed, false if it was not found
   */
  static async removeRefreshToken(token: string) {
    if (!token) {
      return false;
    }

    const existingToken = await RefreshToken.select((t) => [t.token, t.account])
      .where((t) => t.token.equals(token))
      .one();

    if (existingToken) {
      await RefreshToken.delete({ id: existingToken.id });
      return true;
    }

    return false;
  }

  /**
   * Get the refresh token for an account
   *
   * @param account
   * @returns
   */
  static async getRefreshTokenForAccount(account: UserAccountData) {
    const existingToken = await RefreshToken.select((t) => [t.token, t.account])
      .where((t) => t.account.equals(account))
      .one();

    return existingToken;
  }
}
