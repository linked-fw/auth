// The express-session cookie must have a name `cookie.serialize` accepts. With an illegal name
// every response that writes `req.session` throws while sending its headers and never finishes.
//
// Runs over real HTTP against an Express app with the provider's middleware. Uses the BUILT
// package in lib/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'session-test-secret-session-test-secret';
process.env.SESSION_SECRET = 'session-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-session-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { default: express } = await import('express');
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const backendEntry = await import(new URL('backend.js', libDir));
const { SESSION_COOKIE_NAME } = await import(new URL('utils/cookieNames.js', libDir));
const { serialize } = await import('cookie');

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };
let server;
let url;

before(async () => {
  const app = express();
  app.lazyrouter();
  const provider = new AuthBackendProvider(app, fakeLincdServer);
  await provider.setupBeforeControllers();
  app.get('/remember', (req, res) => {
    req.session.remembered = true;
    res.json({ ok: true });
  });
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('the backend entry exports only classes, which the server constructs as providers', () => {
  // @_linked/server calls `new` on every export of a backend entry: a string or arrow function
  // exported here failed at boot with "providerClass is not a constructor".
  for (const [name, value] of Object.entries(backendEntry)) {
    assert.equal(typeof value, 'function', `${name} is not a function`);
    assert.ok(value.prototype, `${name} is not a constructor`);
    assert.match(Function.prototype.toString.call(value), /^class\b/, `${name} is not a class`);
  }
});

test('the session cookie name is one cookie.serialize accepts', () => {
  assert.equal(SESSION_COOKIE_NAME, 'linked.auth');
  assert.doesNotThrow(() => serialize(SESSION_COOKIE_NAME, 'value'));
});

test('a response that writes the session finishes and sets the session cookie', async () => {
  const res = await fetch(`${url}/remember`, { signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const names = res.headers.getSetCookie().map((line) => line.split('=')[0]);
  assert.ok(names.includes('linked.auth'), `set-cookie: ${names.join(', ')}`);
});
