// The React side: what ProvideAuth/useAuth leave behind when a session ends while a tab is open,
// and that a refresh does not replace an unchanged user object. Renders the BUILT hook in jsdom,
// with Server.call going over HTTP to a tiny fake backend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
// @_linked/core keeps its package registry on `window` when there is one, but reads it as a
// global: share one object, as a browser (where window IS the global) does.
globalThis._linked = dom.window._linked = { _modules: {}, _packages: {} };
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// --- fake backend -----------------------------------------------------------------------------
let refreshMode = 'ok';
let issued = 0;
let emailVerified = false;
const calls = [];
const authFor = () => ({
  // a NEW object every time, with the same data — as a real refresh returns it
  user: { id: 'https://id.test/ada', givenName: 'Ada' },
  userAccount: { id: 'https://app.test/account/ada' },
  emailVerified,
});
const token = () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${enc({ alg: 'HS256' })}.${enc({ iat: now, exp: now + 900, jti: ++issued })}.sig`;
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (obj) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    calls.push({ method: req.url.split('/').pop(), body });
    if (req.url.endsWith('/verifyEmail')) {
      emailVerified = true;
      return send({ verified: true });
    }
    if (req.url.endsWith('/resendEmailVerification')) {
      // verified elsewhere (another tab, another device): the session here is stale
      emailVerified = true;
      return send({ verified: true });
    }
    if (req.url.endsWith('/removeAccount')) return send(true);
    if (req.url.endsWith('/signinWithPassword')) return send({ auth: authFor(), accessToken: token() });
    if (req.url.endsWith('/signinOAuth')) {
      return send({ error: 'An account with this email already exists.', action: 'sign_in_to_link' });
    }
    if (req.url.endsWith('/validateToken')) {
      return refreshMode === 'ok'
        ? send({ auth: authFor(), accessToken: token() })
        : send({ error: 'Invalid refresh token' });
    }
    send(null);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = `http://127.0.0.1:${server.address().port}`;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AppContext } = await import('@_linked/server-utils/components/AppContext');
const { LincdServerProxy } = await import('@_linked/server-utils/utils/LincdServerProxy');
const libDir = new URL('../lib/esm/', import.meta.url);
const { ProvideAuth, useAuth } = await import(new URL('hooks/useAuth.js', libDir));
const client = await import(new URL('utils/authClient.js', libDir));
const tokens = await import(new URL('utils/token.js', libDir));

let current;
function Probe() {
  current = useAuth();
  return null;
}

let root;
before(async () => {
  root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(
        AppContext.Provider,
        { value: {} },
        React.createElement(ProvideAuth, null, React.createElement(Probe))
      )
    );
  });
});
after(async () => {
  await act(async () => root.unmount());
  server.close();
  client.resetAuthClient();
  tokens.setAuthTokenStorageMethods(undefined, undefined, undefined);
});

async function signIn() {
  refreshMode = 'ok';
  await act(async () => {
    await current.signinWithPassword('ada@example.test', 'pw');
  });
  assert.equal(current.user?.id, 'https://id.test/ada');
  assert.equal(current.userAccount?.id, 'https://app.test/account/ada');
}

test('a refresh keeps the same user object when the user did not change', async () => {
  await signIn();
  const userBefore = current.user;
  const accountBefore = current.userAccount;
  await act(async () => {
    assert.equal(await client.refreshAccessToken(), true);
  });
  assert.equal(current.user, userBefore, 'auth.user is referentially stable');
  assert.equal(current.userAccount, accountBefore);
});

test('a session that ends while the tab is open leaves NO half-signed-in state', async () => {
  await signIn();
  refreshMode = 'fail';
  await act(async () => {
    assert.equal(await client.refreshAccessToken(), false);
  });
  assert.equal(current.userAccount, null, 'userAccount cleared');
  assert.equal(current.user, null, 'user cleared too (a sign-in page checking user would loop)');
  assert.equal(current.validating, false);
  assert.equal(LincdServerProxy.defaultHeaders.Authorization, undefined, 'no stale Authorization');
  assert.equal(client.getAccessTokenExpiresAt(), undefined, 'nothing scheduled');
});

test('signinOAuth hands the backend error and action to the caller', async () => {
  let result;
  await act(async () => {
    result = await current.signinOAuth('google', { authentication: { idToken: 't' } });
  });
  assert.deepEqual(result, {
    error: 'An account with this email already exists.',
    action: 'sign_in_to_link',
  });
});

const callsTo = (method) => calls.filter((c) => c.method === method);

test('emailVerified reflects auth.emailVerified', async () => {
  emailVerified = false;
  await signIn();
  assert.equal(current.emailVerified, false);
  emailVerified = true;
  await act(async () => {
    assert.equal(await client.refreshAccessToken(), true);
  });
  assert.equal(current.emailVerified, true);
});

test('verifyEmail success, signed in, refreshes the session once (forced)', async () => {
  emailVerified = false;
  await signIn();
  assert.equal(current.emailVerified, false);
  calls.length = 0;
  let result;
  await act(async () => {
    result = await current.verifyEmail('the-token');
  });
  assert.deepEqual(result, { verified: true });
  assert.ok(callsTo('verifyEmail')[0].body.includes('the-token'), 'the token is sent');
  const refreshes = callsTo('validateToken');
  assert.equal(refreshes.length, 1, 'one validateToken');
  assert.ok(refreshes[0].body.includes('forceRefresh'), 'a forced refresh');
  assert.equal(current.emailVerified, true);
});

test('resendEmailVerification answering verified, signed in, refreshes the session once', async () => {
  emailVerified = false;
  await signIn();
  assert.equal(current.emailVerified, false);
  calls.length = 0;
  let result;
  await act(async () => {
    result = await current.resendEmailVerification();
  });
  assert.deepEqual(result, { verified: true });
  assert.equal(callsTo('resendEmailVerification').length, 1);
  assert.equal(callsTo('validateToken').length, 1, 'one validateToken');
  assert.equal(current.emailVerified, true);
});

test('removeAccount(proof) sends the proof as its argument', async () => {
  await signIn();
  calls.length = 0;
  let result;
  await act(async () => {
    result = await current.removeAccount({ password: 'secret-pw' });
  });
  assert.equal(result, true);
  const [call] = callsTo('removeAccount');
  assert.ok(call, 'removeAccount was called');
  assert.ok(call.body.includes('secret-pw'), `the proof is in the request: ${call.body}`);
});

test('native sign-out waits for both stored tokens to be removed', async () => {
  await signIn();
  calls.length = 0;
  const removals = [];
  let releaseRemovals;
  const removed = new Promise((resolve) => {
    releaseRemovals = resolve;
  });
  tokens.setAuthTokenStorageMethods(
    async () => undefined,
    async () => {},
    async (key) => {
      removals.push(key);
      await removed;
    }
  );

  let signout;
  await act(async () => {
    signout = current.signout();
    await Promise.resolve();
  });
  assert.equal(callsTo('signout').length, 0, 'server sign-out waits for storage');
  assert.deepEqual(removals.sort(), ['accessToken', 'refreshToken']);

  releaseRemovals();
  await act(async () => {
    await signout;
  });
  assert.equal(callsTo('signout').length, 1);
  tokens.setAuthTokenStorageMethods(undefined, undefined, undefined);
});
