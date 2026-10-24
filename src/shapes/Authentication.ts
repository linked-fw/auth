import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import * as auth from '../ontologies/auth.js';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { objectProperty } from '@_linked/core/shapes/SHACL';

@linkedShape
export class Authentication extends Shape {
  static targetClass = auth.Authentication;

  @objectProperty({
    path: auth.userAccount,
    maxCount: 1,
  })
  get userAccount(): UserAccount {
    return undefined as any;
  }
}
