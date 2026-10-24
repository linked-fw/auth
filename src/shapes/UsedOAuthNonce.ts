import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import * as auth from '../ontologies/auth.js';
import { literalProperty } from '@_linked/core/shapes/SHACL';
import * as xsd from '@_linked/xsd/ontologies/xsd';

/**
 * A sign-in nonce that has been used. Nonces are issued without storing anything (they are
 * signed, see `utils/oauthNonce.ts`); a record is only written when a nonce is redeemed with a
 * valid provider token, so the same nonce, and with it the same identity token, can never sign
 * in twice. A record is useless once its nonce has expired and is deleted after that.
 *
 * This module stays free of server-only imports (it is part of the client bundle).
 */
@linkedShape
export class UsedOAuthNonce extends Shape {
  static targetClass = auth.UsedOAuthNonce;

  /** SHA-256 (hex) of the raw nonce. */
  @literalProperty({
    path: auth.nonceHash,
    required: true,
    maxCount: 1,
  })
  get nonceHash(): string {
    return '';
  }

  /** When the nonce stopped being valid; the record can be deleted after this. */
  @literalProperty({
    path: auth.expiresAt,
    datatype: xsd.dateTime,
    required: true,
    maxCount: 1,
  })
  get expiresAt(): Date {
    return undefined as any;
  }
}
