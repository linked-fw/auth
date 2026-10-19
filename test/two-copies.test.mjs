// A module can be evaluated twice in one runtime (Vite's SSR runner and Node under `linked start`,
// or two browser bundles). Loads a second copy of each module (a `?copy` query is a distinct module
// instance to Node) and shows that state one copy is given reaches the other, that `ProvideAuth`
// from one copy is seen by the hooks of the other, and that a `FatalConfigError` from one copy is
// recognised by the other.
//
// Runs against the BUILT package in lib/: `npm run build && npm test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT ??= 'http://127.0.0.1:1';
process.env.AUTH_SESSION_CLEANUP = 'false';
process.env.AUTH_COOKIE_PREFIX = 'env_';

const load = (path, copy) =>
  import(new URL(`../lib/esm/${path}?copy=${copy}`, import.meta.url).href);
const twice = async (path, tag = '') => [
  await load(path, `a${tag}`),
  await load(path, `b${tag}`),
];

/** A JWT-shaped token (the client only reads its claims). */
const jwt = (claims) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256' })}.${enc(claims)}.sig`;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a second copy of auth shares its state', () => {
  it('Auth: the statics the app sets on one copy are read by the other', async () => {
    const [a, b] = await twice('utils/auth.js');
    assert.notEqual(a.Auth, b.Auth);
    const before = {
      userType: b.Auth.userType,
      accountType: b.Auth.accountType,
      webIdFor: b.Auth.webIdFor,
    };
    try {
      class OtherPerson {}
      class OtherAccount {}
      const webIdFor = (email) => `https://id.test/${email}`;
      const signinClient = { clientName: 'Two Copies' };
      const oidcSignin = {};
      a.Auth.userType = OtherPerson;
      a.Auth.accountType = OtherAccount;
      a.Auth.webIdFor = webIdFor;
      a.Auth.signinClient = signinClient;
      a.Auth.oidcSignin = oidcSignin;
      assert.equal(b.Auth.userType, OtherPerson);
      assert.equal(b.Auth.accountType, OtherAccount);
      assert.equal(b.Auth.webIdFor, webIdFor);
      assert.equal(b.Auth.signinClient, signinClient);
      assert.equal(b.Auth.oidcSignin, oidcSignin);
    } finally {
      Object.assign(a.Auth, before, { signinClient: undefined, oidcSignin: undefined });
    }
    assert.equal(b.Auth.signinClient, undefined);
  });

  it('cookie prefix: the one set in code and the one read from the environment', async () => {
    const [a, b] = await twice('utils/cookieNames.js');
    const [authA] = await twice('utils/auth.js');
    assert.notEqual(a.getCookiePrefix, b.getCookiePrefix);
    // read from the environment once, by whichever copy asks first
    assert.equal(a.getCookiePrefix(), 'env_');
    process.env.AUTH_COOKIE_PREFIX = 'changed_';
    assert.equal(b.getCookiePrefix(), 'env_');
    try {
      authA.Auth.cookiePrefix = 'cn_';
      assert.equal(b.getCookiePrefix(), 'cn_');
      assert.equal(b.sessionCookieName(), 'cn_linked.auth');
      b.setCookiePrefix(undefined);
      assert.equal(a.authCookieName('accessToken'), 'env_accessToken');
    } finally {
      a.setCookiePrefix(undefined);
      process.env.AUTH_COOKIE_PREFIX = 'env_';
    }
  });

  it('authClient: the token and refresh handler set on one copy are used by the other', async () => {
    const [a, b] = await twice('utils/authClient.js');
    assert.notEqual(a.setAccessToken, b.setAccessToken);
    let refreshes = 0;
    let release;
    const handler = () => {
      refreshes++;
      return new Promise((resolve) => (release = resolve));
    };
    const unregister = a.setRefreshHandler(handler);
    try {
      // one in-flight refresh for both copies
      const first = a.refreshAccessToken();
      assert.equal(b.refreshAccessToken(), first);
      await sleep(0); // the handler starts on the next tick
      release(true);
      assert.equal(await first, true);
      assert.equal(refreshes, 1);

      const now = Date.now();
      const token = jwt({ iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900 });
      a.setAccessToken(token, now);
      assert.equal(b.getCurrentAccessToken(), token);
      assert.equal(b.getAccessTokenExpiresAt(), (Math.floor(now / 1000) + 900) * 1000);
      assert.equal(b.accessTokenNeedsRefresh(now), false);
      assert.equal(b.accessTokenNeedsRefresh(now + 900 * 1000), true);
    } finally {
      unregister();
      b.resetAuthClient();
    }
    assert.equal(a.getCurrentAccessToken(), undefined);
  });

  it('authClient: one refresh timer, cleared through either copy', async () => {
    // fresh copies: nothing a failed test above left in flight
    const [a, b] = await twice('utils/authClient.js', '-timer');
    let refreshes = 0;
    const unregister = a.setRefreshHandler(async () => {
      refreshes++;
      return true;
    });
    try {
      // due now: fires after the minimum delay (1 s) unless cleared
      a.scheduleRefreshAt(Date.now(), Date.now(), 0);
      b.clearScheduledRefresh();
      await sleep(1200);
      assert.equal(refreshes, 0);
    } finally {
      unregister();
      a.resetAuthClient();
    }
  });

  it('authClient: the visibility listeners and the retry hook are installed once', async () => {
    const [a, b] = await twice('utils/authClient.js');
    const { LincdServerProxy } = await import('@_linked/server-utils/utils/LincdServerProxy');

    const added = [];
    const target = () => ({
      visibilityState: 'visible',
      addEventListener: (type) => added.push(type),
      removeEventListener: (type) => added.splice(added.indexOf(type), 1),
    });
    globalThis.window = target();
    globalThis.document = target();
    try {
      const remove = a.installVisibilityRefresh();
      b.installVisibilityRefresh();
      assert.deepEqual(added.sort(), ['focus', 'visibilitychange']);
      remove();
      assert.deepEqual(added, []);
    } finally {
      delete globalThis.window;
      delete globalThis.document;
    }

    const previous = LincdServerProxy.getAuthHandler();
    try {
      assert.equal(a.installServerCallRetry(), true);
      const installed = LincdServerProxy.getAuthHandler();
      assert.ok(installed);
      assert.equal(b.installServerCallRetry(), true);
      assert.equal(LincdServerProxy.getAuthHandler(), installed);
    } finally {
      LincdServerProxy.setAuthHandler(previous);
    }
  });

  it('token: the in-memory token and the native storage registered on one copy', async () => {
    const [a, b] = await twice('utils/token.js');
    assert.notEqual(a.getAuthToken, b.getAuthToken);
    await a.setAuthToken({ key: a.ACCESS_TOKEN, value: 'in-memory' });
    assert.equal(await b.getAuthToken(b.ACCESS_TOKEN), 'in-memory');
    await b.removeAuthToken(b.ACCESS_TOKEN);
    assert.equal(await a.getAuthToken(a.ACCESS_TOKEN), undefined);

    assert.equal(b.isNativeTokenStorage(), false);
    const stored = new Map();
    a.setAuthTokenStorageMethods(
      async (key) => stored.get(key),
      async (key, value) => void stored.set(key, value),
      async (key) => void stored.delete(key)
    );
    assert.equal(b.isNativeTokenStorage(), true);
    await b.setAuthToken({ key: 'refreshToken', value: 'native' });
    assert.equal(stored.get('refreshToken'), 'native');
  });

  it('rateLimit: the store and the limits configured on one copy count for the other', async () => {
    const [a, b] = await twice('utils/rateLimit.js');
    assert.notEqual(a.consumeRateLimit, b.consumeRateLimit);
    const counted = [];
    const store = {
      increment: async (key) => (counted.push(key), counted.length),
      get: async () => 0,
    };
    try {
      a.setRateLimitStore(store);
      a.configureRateLimits({ signup: { ip: { max: 1, windowSeconds: 60 } } });
      assert.equal(b.getRateLimitStore(), store);
      assert.deepEqual(b.resolveRateLimit('signup', 'ip'), { max: 1, windowSeconds: 60 });
      assert.equal((await b.consumeRateLimit('signup', { ip: '10.0.0.1' })).limited, false);
      assert.equal((await b.consumeRateLimit('signup', { ip: '10.0.0.1' })).limited, true);
      assert.equal(counted.length, 2);
    } finally {
      b.resetRateLimits();
    }
    assert.notEqual(a.getRateLimitStore(), store);
  });

  it('sessions: the store, the limits and the rotations under way', async () => {
    const [a, b] = await twice('utils/sessions.js');
    assert.notEqual(a.rotateRefreshToken, b.rotateRefreshToken);
    const previousStore = b.getRefreshSessionStore();
    const previousLimits = b.getSessionLimits();
    let running = 0;
    let mostAtOnce = 0;
    const store = new a.MemoryRefreshSessionStore();
    const find = store.findByTokenHash.bind(store);
    store.findByTokenHash = async (hash) => {
      mostAtOnce = Math.max(mostAtOnce, ++running);
      await sleep(30);
      running--;
      return find(hash);
    };
    try {
      a.setRefreshSessionStore(store);
      assert.equal(b.getRefreshSessionStore(), store);
      a.setSessionLimits({ idleTtl: 123 });
      assert.equal(b.getSessionLimits().idleTtl, 123);

      // the same token through both copies at once: the second waits for the first
      const raw = 'A'.repeat(43);
      const results = await Promise.all([a.rotateRefreshToken(raw), b.rotateRefreshToken(raw)]);
      assert.equal(mostAtOnce, 1);
      assert.deepEqual(
        results.map((r) => r.ok),
        [false, false]
      );
    } finally {
      b.setRefreshSessionStore(previousStore);
      b.setSessionLimits(previousLimits);
    }
  });

  it('nativeOidcSignin: the browser opener registered on one copy', async () => {
    const [a, b] = await twice('utils/nativeOidcSignin.js');
    const token = await import('../lib/esm/utils/token.js');
    token.setAuthTokenStorageMethods(
      async () => undefined,
      async () => {},
      async () => {}
    );
    const redirectUri = 'app.test:/callback';
    const missing = await b.startNativeOidcSignin({ input: 'ada@x.test', redirectUri });
    assert.equal(missing.action, 'no_browser');
    a.setOidcSigninBrowser(async () => undefined);
    try {
      // past the browser check: it goes on to the server (unreachable here)
      const answer = await b
        .startNativeOidcSignin({ input: 'ada@x.test', redirectUri })
        .catch((err) => ({ action: 'threw', err }));
      assert.notEqual(answer.action, 'no_browser');
    } finally {
      b.setOidcSigninBrowser(undefined);
    }
  });

  it('events: a listener on one copy hears an event emitted through the other', async () => {
    const [a, b] = await twice('utils/events.js');
    assert.notEqual(a.onNewUser, b.onNewUser);
    const removed = [];
    const off = a.onAccountWillBeRemoved((account) => void removed.push(account.id));
    const created = [];
    const onNew = (person) => created.push(person.id);
    a.onNewUser(onNew);
    try {
      await b.emitAccountWillBeRemovedEvent({ id: 'acc' });
      await b.emitNewUserEvent({ id: 'person' }, { id: 'acc' });
      assert.deepEqual(removed, ['acc']);
      assert.deepEqual(created, ['person']);
    } finally {
      off();
      b.offNewUser(onNew);
    }
  });
});

describe('the React contexts of a second copy', () => {
  it('ProvideAuth from one copy is seen by useAuth and useAuthRenderLoading of the other', async () => {
    const React = (await import('react')).default;
    const { renderToString } = await import('react-dom/server');
    const { AppContext } = await import('@_linked/server-utils/components/AppContext');
    const [a, b] = await twice('hooks/useAuth.js');
    assert.notEqual(a.ProvideAuth, b.ProvideAuth);
    const h = React.createElement;
    const Probe = () => {
      const auth = b.useAuth();
      const renderLoading = b.useAuthRenderLoading();
      return h(
        'p',
        null,
        `auth:${typeof auth.signout === 'function'} loading:`,
        renderLoading ? renderLoading() : 'none'
      );
    };
    const html = renderToString(
      h(
        AppContext.Provider,
        { value: {} },
        h(a.ProvideAuth, { renderLoading: () => h('i', null, 'waiting') }, h(Probe))
      )
    );
    assert.match(html, /auth:true loading:(<!-- -->)?<i>waiting<\/i>/);
  });
});

describe('a FatalConfigError from another copy', () => {
  it('matches by brand where instanceof does not', async () => {
    const [a, b] = await twice('utils/secrets.js');
    const { isLinkedError } = await import('@_linked/core/utils/linkedError');
    const err = new a.FatalConfigError('no secret');
    assert.equal(err instanceof b.FatalConfigError, false);
    assert.equal(isLinkedError(err, b.FatalConfigError), true);
    assert.equal(isLinkedError(new Error('no secret'), b.FatalConfigError), false);
  });
});
