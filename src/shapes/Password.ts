import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import * as auth from '../ontologies/auth.js';
import { literalProperty, objectProperty } from '@_linked/core/shapes/SHACL';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';

// NOTE: after migration to new authentication system, this shape is not used anymore
@linkedShape
export class Password extends Shape {
  static targetClass = auth.Password;

  @objectProperty({
    path: auth.account,
    shape: UserAccount,
    maxCount: 1,
  })
  get account(): UserAccount {
    return undefined as any;
  }

  @literalProperty({
    path: auth.hash,
    maxCount: 1,
  })
  get hash(): string {
    return '';
  }
}
