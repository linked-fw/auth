// The RPC surface of auth's providers: which methods the server may dispatch over HTTP
// (`/call/@_linked/auth/<method>` and `/call/@_linked/auth/<shape>/<method>`).
//
// - callable: declared with a level. 'public' runs without a session; 'user' answers 401 first.
// - internal: answers 501 in every exposure mode; backend code can still call it.
// - anything else a provider defines is undeclared, which a server in `rpcExposure: 'enforce'`
//   answers with 501. auth declares every method, so an app needs no declarations of its own.
//
// The checks go through the server's own gates (`resolveCallable`, then LinkedServer's
// `assertDispatchAllowed` and `assertSessionForLevel`) with the exposure mode set to 'enforce'.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'unit-test-secret-unit-test-secret';
process.env.SESSION_SECRET = 'unit-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

// connect-sqlite3 (express-session store) writes into <cwd>/data
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { AuthCredentialProvider } = await import(
  new URL('shapes/AuthCredentialProvider.js', libDir)
);
const { isDeclaredInternal } = await import('@_linked/server-utils/utils/callable');
const { BackendProvider } = await import('@_linked/server-utils/utils/BackendProvider');
const { ShapeProvider } = await import('@_linked/server-utils/utils/ShapeProvider');
const { resolveCallable, setRpcExposureMode, getReservedNames } = await import(
  '@_linked/server/utils/rpcExposure'
);
const { LinkedServer } = await import('@_linked/server/shapes/LinkedServer');

setRpcExposureMode('enforce');
// the server logs every refusal; the assertions check them
console.warn = () => {};

/** The intended surface. Changing a level here is a security decision: see the readme. */
const SURFACE = {
  AuthBackendProvider: {
    callable: {
      signinWithPassword: 'public',
      createAccount: 'public',
      signinOAuth: 'public',
      createOAuthNonce: 'public',
      signinTemporary: 'public',
      signinDev: 'public',
      sendResetPasswordLink: 'public',
      sendSigninCode: 'public',
      signinWithCode: 'public',
      startOidcSignin: 'public',
      startNativeOidcSignin: 'public',
      completeNativeOidcSignin: 'public',
      resetPassword: 'public',
      verifyEmail: 'public',
      validateToken: 'public',
      signout: 'public',
      linkOAuthIdentity: 'user',
      resendEmailVerification: 'user',
      getReauthenticationMethods: 'user',
      removeAccount: 'user',
    },
    internal: [
      'upgradePasswordHash',
      'getPasswordForUser',
      'getOrCreateAccount',
      'loadAccountForSession',
      'loadUserForSession',
      'checkSignin',
      'validateRequestToken',
      'refreshSession',
      'getTokenFromRequest',
      'getTokenCandidates',
      'getRefreshTokenFromRequest',
    ],
  },
  AuthCredentialProvider: {
    callable: {
      userHasAuthCredential: 'user',
      userHasPassword: 'user',
    },
    internal: ['createNewCredential', 'hasAuthCredential'],
  },
};

const CLASSES = { AuthBackendProvider, AuthCredentialProvider };

/** A provider as the server holds it, without running its constructor. */
const providerOf = (cls) => Object.create(cls.prototype);

const NO_SESSION = Object.freeze({});
const SIGNED_IN = Object.freeze({ linkedAuth: { userAccount: { id: 'https://app.test/acc/1' } } });

/**
 * What the server answers before running `method` of `provider` for an HTTP call carrying
 * `request`: 'runs', or the status it refuses with. Same gates, same order as LinkedServer.
 */
function dispatch(provider, method, request, route = 'generic') {
  const resolution = resolveCallable(provider, method);
  if (resolution.status === 'missing') return 501;
  const server = LinkedServer.prototype;
  try {
    server.assertDispatchAllowed.call(server, '@_linked/auth', method, provider, resolution, request, route);
    server.assertSessionForLevel.call(server, '@_linked/auth', method, resolution, request);
  } catch (err) {
    if (typeof err?.status === 'number') return err.status;
    throw err;
  }
  return 'runs';
}

/** Every method name a provider class defines itself or inherits from auth's own classes. */
function providerMethodNames(cls) {
  const names = new Set();
  for (let proto = cls.prototype; proto && proto !== BackendProvider.prototype && proto !== ShapeProvider.prototype && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (d && 'value' in d && typeof d.value === 'function') names.add(name);
    }
  }
  return [...names];
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Every RPC auth's own code makes, read from src: `Server.call(packageName, '<m>')` reaches the
 * backend provider, `Server.call(this, '<m>')` in a shape reaches that shape's provider.
 */
function rpcCallsInSource() {
  const calls = [];
  for (const file of sourceFiles(srcDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/Server\.call\(\s*(packageName|this)\s*,\s*['"]([A-Za-z0-9_$]+)['"]/g)) {
      calls.push({ file: path.relative(srcDir, file), target: m[1], method: m[2] });
    }
  }
  return calls;
}

// Shape wrappers that only backend code calls (a backend-to-backend Server.call skips the
// exposure gates). Each must be internal and have no caller outside the backend.
const BACKEND_ONLY_WRAPPERS = { 'shapes/AuthCredential.ts': ['createNewCredential'] };

for (const [className, { callable, internal }] of Object.entries(SURFACE)) {
  const cls = CLASSES[className];

  for (const [method, level] of Object.entries(callable)) {
    test(`${className}.${method} is callable at '${level}' under enforce`, () => {
      assert.equal(typeof cls.prototype[method], 'function');
      const provider = providerOf(cls);
      assert.deepEqual(
        { ...resolveCallable(provider, method), owner: undefined },
        { status: 'callable', level, owner: undefined }
      );
      assert.equal(dispatch(provider, method, SIGNED_IN), 'runs');
      assert.equal(dispatch(provider, method, NO_SESSION), level === 'public' ? 'runs' : 401);
    });
  }

  for (const method of internal) {
    test(`${className}.${method} is internal`, () => {
      assert.equal(typeof cls.prototype[method], 'function');
      assert.equal(isDeclaredInternal(cls, method), true);
      assert.equal(dispatch(providerOf(cls), method, SIGNED_IN), 501);
      assert.equal(dispatch(providerOf(cls), method, NO_SESSION), 501);
    });
  }

  test(`${className} has no undeclared method`, () => {
    // Fails when a method is added to the provider without declaring it callable or internal.
    const declared = new Set([...Object.keys(callable), ...internal]);
    const reserved = getReservedNames();
    const undeclared = providerMethodNames(cls).filter(
      (name) => !reserved.has(name) && !declared.has(name)
    );
    assert.deepEqual(undeclared, [], `declare these in ${className}'s source and in SURFACE`);
    for (const name of providerMethodNames(cls)) {
      assert.notEqual(resolveCallable(providerOf(cls), name).status, 'undeclared', name);
    }
  });
}

test('every RPC in auth\'s source reaches a callable method at the level in SURFACE', () => {
  const calls = rpcCallsInSource();
  assert.ok(calls.length > 10, 'the source scan found the calls');
  for (const { file, target, method } of calls) {
    if (BACKEND_ONLY_WRAPPERS[file]?.includes(method)) continue;
    const className = target === 'packageName' ? 'AuthBackendProvider' : 'AuthCredentialProvider';
    if (target === 'this') assert.equal(file, 'shapes/AuthCredential.ts', `${file}: ${method}`);
    const level = SURFACE[className].callable[method];
    assert.ok(level, `${file} calls ${className}.${method}, which is not callable`);
    assert.equal(dispatch(providerOf(CLASSES[className]), method, SIGNED_IN), 'runs', method);
  }
});

test('backend-only shape wrappers are internal and only the backend calls them', () => {
  for (const [file, methods] of Object.entries(BACKEND_ONLY_WRAPPERS)) {
    for (const method of methods) {
      assert.ok(SURFACE.AuthCredentialProvider.internal.includes(method), method);
      const callers = sourceFiles(srcDir)
        .filter((f) => fs.readFileSync(f, 'utf8').includes(`.${method}(`))
        .map((f) => path.relative(srcDir, f));
      assert.deepEqual(callers.filter((f) => f !== 'backend.ts' && !f.startsWith('shapes/AuthCredential')), [], file);
    }
  }
});

test('the client has no wrapper for hasAuthCredential', async () => {
  const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
  assert.equal(AuthCredential.hasAuthCredential, undefined);
  assert.equal(typeof AuthCredential.userHasAuthCredential, 'function');
});

test('the shape route resolves the same way as the generic route', () => {
  // /call/<pkg>/<shape>/<method> finds the shape's provider instance and runs the same gates
  const provider = providerOf(AuthCredentialProvider);
  assert.equal(dispatch(provider, 'userHasPassword', NO_SESSION, 'shape'), 401);
  assert.equal(dispatch(provider, 'userHasPassword', SIGNED_IN, 'shape'), 'runs');
  assert.equal(dispatch(provider, 'createNewCredential', SIGNED_IN, 'shape'), 501);
  assert.equal(dispatch(provider, 'hasAuthCredential', SIGNED_IN, 'shape'), 501);
});

test('lifecycle hooks are never dispatched', () => {
  for (const name of ['setupBeforeControllers', 'initRequest', 'supplyDataForRequest', 'dispose']) {
    assert.equal(dispatch(providerOf(AuthBackendProvider), name, SIGNED_IN), 501, name);
  }
});

test('an app subclass keeps auth\'s levels and must declare what it adds', () => {
  class AppAuthProvider extends AuthBackendProvider {
    async signinWithPassword() {}
    async removeAccount() {}
    async upgradePasswordHash() {}
    async getOrCreateAccount() {}
    async appExtra() {}
  }
  const provider = providerOf(AppAuthProvider);
  // overrides keep the level declared on AuthBackendProvider
  assert.equal(dispatch(provider, 'signinWithPassword', NO_SESSION), 'runs');
  assert.equal(dispatch(provider, 'removeAccount', NO_SESSION), 401);
  assert.equal(dispatch(provider, 'removeAccount', SIGNED_IN), 'runs');
  // inherited without override
  assert.equal(dispatch(provider, 'validateToken', NO_SESSION), 'runs');
  // internal stays internal, overridden or not
  assert.equal(isDeclaredInternal(AppAuthProvider, 'upgradePasswordHash'), true);
  assert.equal(dispatch(provider, 'upgradePasswordHash', SIGNED_IN), 501);
  assert.equal(dispatch(provider, 'getOrCreateAccount', SIGNED_IN), 501);
  assert.equal(dispatch(provider, 'getTokenCandidates', SIGNED_IN), 501);
  // a method the app adds is undeclared: refused under enforce until the app declares it
  assert.equal(resolveCallable(provider, 'appExtra').status, 'undeclared');
  assert.equal(dispatch(provider, 'appExtra', SIGNED_IN), 501);
});

test('the OAuth account helpers are not provider methods', () => {
  // every provider method is part of the RPC surface; these act on any identity or account
  for (const name of ['verifyOAuthIdentity', 'findLinks', 'createLink', 'findLinkedProviders',
    'personHasPassword', 'upgradeLegacyLink', 'loadAccountWithPerson', 'findAccountForWebID']) {
    assert.equal(AuthBackendProvider.prototype[name], undefined, name);
    assert.equal(AuthCredentialProvider.prototype[name], undefined, name);
  }
});
