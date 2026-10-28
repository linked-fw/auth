// A mock Solid-OIDC issuer for the sign-in tests: discovery, JWKS (ES256), an authorization
// endpoint that redirects straight back (no login page), a token endpoint that checks PKCE and the
// DPoP proof, and a separate host serving WebID profiles. Each knob lets a test tamper with one
// thing the relying party must refuse.
//
// Both servers listen on localhost, so the relying party runs with `allowLocalhost`. The profile
// host has its own port, so its WebIDs are on another origin than the issuer.
import http from 'node:http';
import crypto from 'node:crypto';

const b64url = (input) => Buffer.from(input).toString('base64url');

function signJwt(header, payload, privateKey) {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${signature.toString('base64url')}`;
}

function decodeJwt(jwt) {
  const [header, payload, signature] = String(jwt).split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
    data: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

const thumbprint = (jwk) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');

/** Check a DPoP proof as RFC 9449 §4.3 asks. Returns the key's thumbprint, or throws. */
function verifyDpopProof(proof, method, url) {
  const { header, payload, data, signature } = decodeJwt(proof);
  if (header.typ !== 'dpop+jwt') throw new Error('typ');
  if (header.alg !== 'ES256' || !header.jwk) throw new Error('alg/jwk');
  const key = crypto.createPublicKey({ key: header.jwk, format: 'jwk' });
  if (!crypto.verify('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }, signature)) {
    throw new Error('signature');
  }
  if (payload.htm !== method || payload.htu !== url) throw new Error('htm/htu');
  if (typeof payload.jti !== 'string' || typeof payload.iat !== 'number') throw new Error('jti/iat');
  return thumbprint(header.jwk);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function listen(server) {
  // no host: dual stack, so `localhost` reaches it whether it resolves to 127.0.0.1 or ::1
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

/**
 * Start the issuer and the profile host.
 *
 * Knobs (set on the returned object between sign-ins):
 * - `authorizeError`: answer the authorization request with this `error` instead of a code.
 * - `claims(defaults)`: return the ID token's claims (default: unchanged). A claim set to
 *   `undefined` is left out.
 * - `signWithOtherKey`: sign the ID token with a key that is not in the JWKS.
 * - `profiles`: path → Turtle body of the profile host; `profileRequests` counts its requests.
 * - `webIdFor(email)`: the WebID put in the token (default: on the issuer's origin).
 * - `accessTokenFormat`: `'opaque'` (default) or `'jwt'`, a Solid-OIDC access token
 *   (`mintAccessToken`) bound to the token request's DPoP key.
 * - `tokenType`: the token response's `token_type` (default `DPoP`).
 * - `rotateKey()`: sign from now on with a new key `k2`, published beside `k1`.
 * - `jwksDown`: the JWKS endpoint answers 500.
 */
export async function startMockIssuer() {
  const signingKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const otherKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = { ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' };

  let currentKey = { privateKey: signingKey.privateKey, kid: 'k1' };
  const published = [publicJwk];
  const codes = new Map();
  const mock = {
    /** The issuer's origin; `issuer` is this plus `issuerPath`. */
    origin: '',
    issuerPath: '',
    get issuer() {
      return `${mock.origin}${mock.issuerPath}`;
    },
    /** When set, the metadata document names this issuer instead of its own. */
    metadataIssuer: undefined,
    /** Bytes of filler added to the metadata document. */
    metadataPadding: 0,
    profileOrigin: '',
    authorizeRequests: [],
    tokenRequests: [],
    profileRequests: 0,
    discoveryRequests: 0,
    profiles: new Map(),
    authorizeError: undefined,
    claims: (defaults) => defaults,
    signWithOtherKey: false,
    accessTokenFormat: 'opaque',
    tokenType: 'DPoP',
    jwksDown: false,
    jwksRequests: 0,
    email: 'ada@example.test',
    emailVerified: true,
    webIdFor: (email) => `${mock.issuer}/id/${crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)}#me`,
    reset() {
      codes.clear();
      mock.authorizeRequests = [];
      mock.tokenRequests = [];
      mock.profileRequests = 0;
      mock.discoveryRequests = 0;
      mock.issuerPath = '';
      mock.metadataIssuer = undefined;
      mock.metadataPadding = 0;
      mock.profiles = new Map();
      mock.authorizeError = undefined;
      mock.claims = (defaults) => defaults;
      mock.signWithOtherKey = false;
      mock.accessTokenFormat = 'opaque';
      mock.tokenType = 'DPoP';
      mock.jwksDown = false;
      mock.jwksRequests = 0;
      mock.email = 'ada@example.test';
      mock.emailVerified = true;
      mock.webIdFor = (email) =>
        `${mock.issuer}/id/${crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)}#me`;
    },
  };

  const issuerServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, mock.origin);
    if (mock.issuerPath && url.pathname.startsWith(mock.issuerPath)) {
      url.pathname = url.pathname.slice(mock.issuerPath.length) || '/';
    }
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      mock.discoveryRequests++;
      return json(200, {
        issuer: mock.metadataIssuer ?? mock.issuer,
        authorization_endpoint: `${mock.issuer}/authorize`,
        token_endpoint: `${mock.issuer}/token`,
        jwks_uri: `${mock.issuer}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
        dpop_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['openid', 'webid', 'email'],
        claims_supported: ['sub', 'webid', 'email', 'email_verified', 'auth_time'],
        authorization_response_iss_parameter_supported: true,
        ...(mock.metadataPadding ? { filler: 'x'.repeat(mock.metadataPadding) } : {}),
      });
    }
    if (url.pathname === '/jwks') {
      mock.jwksRequests++;
      return mock.jwksDown ? json(500, { error: 'down' }) : json(200, { keys: published });
    }

    if (url.pathname === '/authorize') {
      const params = Object.fromEntries(url.searchParams);
      mock.authorizeRequests.push(params);
      const back = new URL(params.redirect_uri);
      back.searchParams.set('state', params.state);
      back.searchParams.set('iss', mock.issuer);
      if (mock.authorizeError) {
        back.searchParams.set('error', mock.authorizeError);
      } else {
        const code = crypto.randomBytes(16).toString('hex');
        codes.set(code, params);
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.href });
      return res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      const record = { form, dpop: null, error: null };
      mock.tokenRequests.push(record);
      const fail = (error) => {
        record.error = error;
        json(400, { error });
      };
      const authorized = codes.get(form.code);
      codes.delete(form.code);
      if (form.grant_type !== 'authorization_code' || !authorized) return fail('invalid_grant');
      if (form.client_id !== authorized.client_id || form.redirect_uri !== authorized.redirect_uri) {
        return fail('invalid_grant');
      }
      const challenge = crypto.createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
      if (authorized.code_challenge_method !== 'S256' || challenge !== authorized.code_challenge) {
        return fail('invalid_grant');
      }
      let jkt;
      try {
        jkt = verifyDpopProof(req.headers.dpop, 'POST', `${mock.issuer}/token`);
      } catch (error) {
        return fail('invalid_dpop_proof');
      }
      if (authorized.dpop_jkt && authorized.dpop_jkt !== jkt) return fail('invalid_dpop_proof');
      record.dpop = { jkt };

      const now = Math.floor(Date.now() / 1000);
      const email = mock.email;
      const claims = mock.claims({
        iss: mock.issuer,
        aud: authorized.client_id,
        sub: `sub-${email}`,
        iat: now,
        exp: now + 300,
        auth_time: now - 5,
        nonce: authorized.nonce,
        webid: mock.webIdFor(email),
        email,
        email_verified: mock.emailVerified,
      });
      for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
      const key = mock.signWithOtherKey ? otherKey.privateKey : signingKey.privateKey;
      const idToken = signJwt({ alg: 'ES256', kid: 'k1', typ: 'JWT' }, claims, key);
      const accessToken =
        mock.accessTokenFormat === 'jwt'
          ? mock.mintAccessToken({ webId: claims.webid, clientId: authorized.client_id, jkt })
          : 'issuer-access-token';
      return json(200, { access_token: accessToken, token_type: mock.tokenType, expires_in: 300, id_token: idToken });
    }

    res.writeHead(404);
    res.end();
  });

  const profileServer = http.createServer((req, res) => {
    mock.profileRequests++;
    const body = mock.profiles.get(new URL(req.url, mock.profileOrigin).pathname);
    if (body === undefined) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/turtle' });
    res.end(body);
  });

  mock.origin = `http://localhost:${await listen(issuerServer)}`;
  mock.profileOrigin = `http://localhost:${await listen(profileServer)}`;

  /** A WebID on the profile host whose profile names `issuers`. */
  mock.addProfile = (name, issuers) => {
    const path = `/${name}/profile`;
    const webId = `${mock.profileOrigin}${path}#me`;
    mock.profiles.set(
      path,
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .\n<#me> ${
        issuers.length ? `solid:oidcIssuer ${issuers.map((i) => `<${i}>`).join(', ')}` : 'a <http://xmlns.com/foaf/0.1/Person>'
      } .\n`
    );
    return webId;
  };

  /**
   * A Solid-OIDC access token (`typ` `at+jwt`) for `webId`, issued to `clientId`, bound to the DPoP
   * key whose thumbprint is `jkt`. `claims` overrides or (with `undefined`) removes claims.
   */
  mock.mintAccessToken = ({ webId, clientId, jkt, claims = {}, otherKey: useOtherKey = false, typ = 'at+jwt' }) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: mock.issuer,
      aud: 'solid',
      sub: webId,
      webid: webId,
      client_id: clientId,
      cnf: { jkt },
      scope: 'webid',
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
      ...claims,
    };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const key = useOtherKey ? otherKey.privateKey : currentKey.privateKey;
    return signJwt({ alg: 'ES256', kid: currentKey.kid, typ }, payload, key);
  };

  mock.rotateKey = () => {
    const next = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    published.push({ ...next.publicKey.export({ format: 'jwk' }), kid: 'k2', alg: 'ES256', use: 'sig' });
    currentKey = { privateKey: next.privateKey, kid: 'k2' };
  };

  /**
   * Play the browser: follow the authorization URL to the redirect back, and return the callback's
   * query string.
   */
  mock.authorize = async (authorizationUrl) => {
    const response = await fetch(authorizationUrl, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location) throw new Error(`the mock issuer answered ${response.status} without a redirect`);
    return new URL(location).search;
  };

  mock.close = () => {
    issuerServer.closeAllConnections?.();
    profileServer.closeAllConnections?.();
    issuerServer.close();
    profileServer.close();
  };
  return mock;
}
