// The Solid-OIDC exchange (utils/oidcSignin) against a mock issuer (mockIssuer.mjs): the
// authorization URL, the code exchange with PKCE and a DPoP proof, the ID-token checks, the
// required claims and the issuer check against the WebID's profile.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). Every request goes
// through the real guarded fetch, with `allowLocalhost` since the mock runs on localhost.
import { test, before, after, beforeEach, mock as nodeMock } from 'node:test';
import assert from 'node:assert/strict';
import { startMockIssuer } from './mockIssuer.mjs';

const libDir = new URL('../lib/esm/', import.meta.url);
const { createOidcRelyingParty, sameIssuer, jwkThumbprint, OIDC_SIGNIN_SCOPE } = await import(
  new URL('utils/oidcSignin.js', libDir)
);

const CLIENT_ID = 'https://app.test/.well-known/linked-client.jsonld';
const REDIRECT_URI = 'https://app.test/auth/oidc/callback';

let issuer;
let rp;
let warnings;

before(async () => {
  issuer = await startMockIssuer();
});
after(() => issuer.close());

beforeEach(() => {
  issuer.reset();
  rp = createOidcRelyingParty({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, allowLocalhost: true });
  warnings = [];
  nodeMock.method(console, 'warn', (line) => warnings.push(String(line)));
});

/** Begin, let the issuer redirect back, and complete. */
async function signIn(options = {}, rpToUse = rp) {
  const begun = await rpToUse.begin({ issuer: issuer.issuer, loginHint: 'ada@example.test', ...options });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const query = await issuer.authorize(begun.url);
  return { begun, result: await rpToUse.complete(begun.pending, query) };
}

test('the authorization URL: code flow, PKCE S256, state, nonce, dpop_jkt, hints', async () => {
  const begun = await rp.begin({
    issuer: issuer.issuer,
    loginHint: 'ada@example.test',
    prompt: 'none',
    providerHint: 'google',
  });
  assert.equal(begun.ok, true);
  const url = new URL(begun.url);
  assert.equal(url.origin + url.pathname, `${issuer.issuer}/authorize`);
  const p = Object.fromEntries(url.searchParams);
  assert.equal(p.client_id, CLIENT_ID);
  assert.equal(p.redirect_uri, REDIRECT_URI);
  assert.equal(p.response_type, 'code');
  assert.equal(p.scope, OIDC_SIGNIN_SCOPE);
  assert.equal(p.code_challenge_method, 'S256');
  assert.ok(p.code_challenge && p.code_challenge !== begun.pending.codeVerifier);
  assert.equal(p.state, begun.pending.state);
  assert.equal(p.nonce, begun.pending.nonce);
  assert.equal(p.login_hint, 'ada@example.test');
  assert.equal(p.prompt, 'none');
  assert.equal(p.provider_hint, 'google');
  assert.equal(p.dpop_jkt, jwkThumbprint(begun.pending.dpopPublicJwk));
  // the pending record is plain JSON, so it can be stored
  assert.deepEqual(JSON.parse(JSON.stringify(begun.pending)), begun.pending);
  assert.equal(begun.pending.issuer, issuer.issuer);
  assert.equal(begun.pending.loginHint, 'ada@example.test');
});

test('without prompt or provider hint, neither is sent', async () => {
  const begun = await rp.begin({ issuer: issuer.issuer });
  const p = new URL(begun.url).searchParams;
  assert.equal(p.has('prompt'), false);
  assert.equal(p.has('provider_hint'), false);
  assert.equal(p.has('login_hint'), false);
});

test('a full sign-in: the code is exchanged with a DPoP proof and the identity is returned', async () => {
  const { begun, result } = await signIn();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.identity.webId, issuer.webIdFor('ada@example.test'));
  assert.equal(result.identity.issuer, issuer.issuer);
  assert.equal(result.identity.email, 'ada@example.test');
  assert.equal(result.identity.emailVerified, true);
  assert.equal(typeof result.identity.authTime, 'number');
  assert.equal(result.identity.subject, 'sub-ada@example.test');
  assert.equal('accessToken' in result.identity, false, 'issuer tokens are discarded');
  const [token] = issuer.tokenRequests;
  assert.equal(token.error, null);
  assert.equal(token.dpop.jkt, jwkThumbprint(begun.pending.dpopPublicJwk));
  assert.equal(token.form.code_verifier, begun.pending.codeVerifier);
  // the WebID is on the issuer's origin: no profile fetch
  assert.equal(issuer.profileRequests, 0);
});

test('a wrong nonce is refused', async () => {
  issuer.claims = (c) => ({ ...c, nonce: 'another-nonce' });
  const { result } = await signIn();
  assert.deepEqual(result, { ok: false, error: 'invalid_token' });
  assert.match(warnings.join('\n'), /"nonce"/);
});

test('a wrong audience is refused', async () => {
  issuer.claims = (c) => ({ ...c, aud: 'https://other.test/client' });
  const { result } = await signIn();
  assert.deepEqual(result, { ok: false, error: 'invalid_token' });
  assert.match(warnings.join('\n'), /"aud"/);
});

test('a token from another issuer (iss) is refused', async () => {
  issuer.claims = (c) => ({ ...c, iss: 'https://evil.test' });
  const { result } = await signIn();
  assert.deepEqual(result, { ok: false, error: 'invalid_token' });
  assert.match(warnings.join('\n'), /"iss"/);
});

test('an expired ID token is refused', async () => {
  issuer.claims = (c) => ({ ...c, iat: c.iat - 3600, exp: c.iat - 1800 });
  const { result } = await signIn();
  assert.deepEqual(result, { ok: false, error: 'invalid_token' });
  assert.match(warnings.join('\n'), /"exp"/);
});

test('an ID token not signed by a key of the issuer JWKS is refused', async () => {
  issuer.signWithOtherKey = true;
  const { result } = await signIn();
  assert.deepEqual(result, { ok: false, error: 'invalid_token' });
  assert.match(warnings.join('\n'), /signature verification failed/);
});

test('a missing webid claim is refused', async () => {
  issuer.claims = (c) => ({ ...c, webid: undefined });
  const { result } = await signIn();
  assert.deepEqual(result, { ok: false, error: 'missing_claim', detail: 'webid' });
});

test('a missing auth_time claim is refused', async () => {
  issuer.claims = (c) => ({ ...c, auth_time: undefined });
  const { result } = await signIn();
  assert.deepEqual(result, { ok: false, error: 'missing_claim', detail: 'auth_time' });
});

test('email is optional unless required', async () => {
  issuer.claims = (c) => ({ ...c, email: undefined, email_verified: undefined });
  const { result } = await signIn();
  assert.equal(result.ok, true);
  assert.equal(result.identity.email, undefined);

  const strict = createOidcRelyingParty({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    allowLocalhost: true,
    requireEmail: true,
  });
  const second = await signIn({}, strict);
  assert.deepEqual(second.result, { ok: false, error: 'missing_claim', detail: 'email' });
});

test('issuer check: a WebID on another origin whose profile names the issuer is accepted', async () => {
  const webId = issuer.addProfile('alice', ['https://other-issuer.test', `${issuer.issuer}/`]);
  issuer.claims = (c) => ({ ...c, webid: webId });
  const { result } = await signIn();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.identity.webId, webId);
  assert.equal(issuer.profileRequests, 1);
});

test('issuer check: an issuer not in the WebID profile is refused', async () => {
  const webId = issuer.addProfile('mallory', ['https://her-own-issuer.test']);
  issuer.claims = (c) => ({ ...c, webid: webId });
  const { result } = await signIn();
  assert.deepEqual(result, { ok: false, error: 'issuer_refused' });
  assert.equal(issuer.profileRequests, 1);
});

test('issuer check: a profile naming no issuer, or none at all, is refused', async () => {
  const webId = issuer.addProfile('bob', []);
  issuer.claims = (c) => ({ ...c, webid: webId });
  assert.deepEqual((await signIn()).result, { ok: false, error: 'issuer_refused' });
  issuer.claims = (c) => ({ ...c, webid: `${issuer.profileOrigin}/missing/profile#me` });
  assert.deepEqual((await signIn()).result, { ok: false, error: 'issuer_refused' });
});

test('issuer check: a WebID this server does not fetch is refused without a request', async () => {
  issuer.claims = (c) => ({ ...c, webid: 'https://10.0.0.1/profile#me' });
  assert.deepEqual((await signIn()).result, { ok: false, error: 'issuer_refused' });
  issuer.claims = (c) => ({ ...c, webid: 'urn:uuid:1234' });
  assert.deepEqual((await signIn()).result, { ok: false, error: 'issuer_refused' });
  assert.equal(issuer.profileRequests, 0);
});

test('login_required (prompt=none) is returned, not thrown', async () => {
  issuer.authorizeError = 'login_required';
  const { result } = await signIn({ prompt: 'none' });
  assert.deepEqual(result, { ok: false, error: 'login_required', detail: 'login_required' });
  assert.equal(issuer.tokenRequests.length, 0);
});

test('other authorization errors map to the app codes', async () => {
  for (const [answered, expected] of [
    ['consent_required', 'interaction_required'],
    ['interaction_required', 'interaction_required'],
    ['access_denied', 'access_denied'],
    ['server_error', 'failed'],
  ]) {
    issuer.authorizeError = answered;
    const { result } = await signIn();
    assert.deepEqual(result, { ok: false, error: expected, detail: answered }, answered);
  }
});

test('a callback with another state is refused (the pending record is the other one)', async () => {
  const first = await rp.begin({ issuer: issuer.issuer });
  const second = await rp.begin({ issuer: issuer.issuer });
  const query = await issuer.authorize(first.url);
  const result = await rp.complete(second.pending, query);
  assert.equal(result.ok, false);
  assert.equal(issuer.tokenRequests.length, 0);
});

test('a code is redeemed once: replaying the callback fails', async () => {
  const begun = await rp.begin({ issuer: issuer.issuer });
  const query = await issuer.authorize(begun.url);
  assert.equal((await rp.complete(begun.pending, query)).ok, true);
  const replay = await rp.complete(begun.pending, query);
  assert.deepEqual(replay, { ok: false, error: 'failed', detail: 'invalid_grant' });
});

test('begin: an issuer this server does not fetch, or one without metadata', async () => {
  assert.deepEqual(await rp.begin({ issuer: 'https://10.0.0.1' }), { ok: false, error: 'invalid_issuer' });
  assert.deepEqual(await rp.begin({ issuer: 'ftp://issuer.test' }), { ok: false, error: 'invalid_issuer' });
  const strict = createOidcRelyingParty({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
  assert.deepEqual(await strict.begin({ issuer: issuer.issuer }), { ok: false, error: 'invalid_issuer' });
  assert.deepEqual(await rp.begin({ issuer: `${issuer.profileOrigin}` }), {
    ok: false,
    error: 'issuer_unreachable',
  });
});

test('sameIssuer ignores one trailing slash only', () => {
  assert.equal(sameIssuer('https://i.test', 'https://i.test/'), true);
  assert.equal(sameIssuer('https://i.test/', 'https://i.test/'), true);
  assert.equal(sameIssuer('https://i.test', 'https://i.test/x'), false);
  assert.equal(sameIssuer('https://i.test', 'http://i.test'), false);
});
