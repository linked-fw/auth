/**
 * Registers every shape this package defines, and nothing else.
 *
 * A shape registers when its module is evaluated, so this module exists to be
 * imported for that side effect alone: `import '<package>/shapes/index';`
 * It has no exports and pulls in no components or providers, so it loads in
 * plain node (no CSS, no React tree) as well as in a bundle. The package
 * entry imports it instead of listing shapes itself.
 */
import '../ontologies/index.js';
import './AuthCredential.js';
import './Authentication.js';
import './IdentityToken.js';
import './Password.js';
import './RefreshToken.js';
import './UsedOAuthNonce.js';
