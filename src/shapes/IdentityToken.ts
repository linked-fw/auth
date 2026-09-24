import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import { auth } from '../ontologies/auth.js';
import { Server } from '@_linked/server-utils/utils/Server';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { QResult } from '@_linked/core/queries/SelectQuery';
import type { UserAccountData } from '../types/auth.js';
import { literalProperty, objectProperty } from '@_linked/core/shapes/SHACL';

export type IdentityTokenResult = QResult<
  IdentityToken,
  {
    sub: string;
    token: string;
    phoneIdentifier: string;
    email: string;
    account: UserAccountData;
  }
>;

export type SubjectLinkedIdentityTokenResult = QResult<
  IdentityToken,
  {
    sub: string;
    email: string;
    account: UserAccountData;
  }
>;

@linkedShape
export class IdentityToken extends Shape {
  static targetClass = auth.IdentityToken;

  // The OIDC `sub` claim. Not named `subject`: that is a query-builder field,
  // so `select(t => t.subject)` would resolve to it instead of this property.
  // The RDF predicate stays auth:subject.
  @literalProperty({
    path: auth.subject,
    maxCount: 1,
  })
  get sub(): string {
    return '';
  }

  @literalProperty({
    path: auth.token,
    maxCount: 1,
  })
  get token(): string {
    return '';
  }

  @literalProperty({
    path: auth.phoneIdentifier,
    maxCount: 1,
  })
  get phoneIdentifier(): string {
    return '';
  }

  @literalProperty({
    path: auth.email,
    maxCount: 1,
  })
  get email(): string {
    return '';
  }

  @objectProperty({
    path: auth.account,
    maxCount: 1,
    shape: ['@_linked/sioc', 'UserAccount'],
    description: 'The account of the identity token.',
  })
  get account(): UserAccount {
    return undefined as any;
  }

  /**
   * Searches for an existing token that matches the provided email or subject.
   * @param email The email to match against.
   * @param sub The subject to match against.
   * @returns The matching token, or undefined if no match was found.
   */
  static async getTokenByEmailOrSubject(
    email: string,
    sub: string
  ): Promise<IdentityTokenResult> {
    let existingToken: IdentityTokenResult;
    if (email) {
      existingToken = await IdentityToken.select((t) => {
        return [
          t.email,
          t.sub,
          t.token,
          t.phoneIdentifier,
          t.account.select((a) => {
            return [a.accountOf];
          }),
        ];
      })
        .where((t) => {
          return t.email.equals(email);
        })
        .one();
    } else if (sub) {
      existingToken = await IdentityToken.select((t) => {
        return [
          t.email,
          t.sub,
          t.token,
          t.phoneIdentifier,
          t.account.select((a) => {
            return [a.accountOf];
          }),
        ];
      })
        .where((t) => {
          return t.sub.equals(sub);
        })
        .one();
    }
    return existingToken;
  }

  static async getTokensBySubject(
    sub: string
  ): Promise<SubjectLinkedIdentityTokenResult[]> {
    if (!sub) return [];
    return await IdentityToken.select((token) => [
      token.email,
      token.sub,
      token.account.select((account) => [account.email, account.accountOf]),
    ]).where((token) => token.sub.equals(sub));
  }

  static async getTokenByAccount(
    account: UserAccountData
  ): Promise<IdentityTokenResult> {
    const existingToken = await IdentityToken.select((t) => {
      return [
        t.email,
        t.sub,
        t.token,
        t.phoneIdentifier,
        t.account.select((a) => {
          return [a.accountOf];
        }),
      ];
    })
      .where((t) => {
        return t.account.equals(account);
      })
      .one();

    return existingToken;
  }

  /**
   * checks if the account has an existing token.
   *
   * @param account UserAccount
   * @returns boolean
   */
  static async hasToken(account: UserAccountData): Promise<boolean> {
    const existingToken = await IdentityToken.select((t) => {
      return [
        t.email,
        t.sub,
        t.token,
        t.phoneIdentifier,
        t.account.select((a) => {
          return [a.accountOf];
        }),
      ];
    })
      .where((t) => {
        return t.account.equals(account);
      })
      .one();

    return !!existingToken;
  }
}
