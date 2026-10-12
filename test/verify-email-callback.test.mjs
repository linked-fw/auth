// VerifyEmailCallback in jsdom: a token is redeemed once, and a route reused for a new link
// redeems the new token. Renders the BUILT component, with Server.call going over HTTP to a tiny
// fake backend.
import './cssStub.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis._linked = dom.window._linked = { _modules: {}, _packages: {} };
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const name of ['HTMLElement', 'Node', 'Element', 'MutationObserver', 'getComputedStyle']) {
  globalThis[name] ??= dom.window[name];
}
for (const name of ['Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent']) {
  globalThis[name] = dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// --- fake backend -----------------------------------------------------------------------------
const verifyCalls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (obj) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (req.url.endsWith('/verifyEmail')) {
      verifyCalls.push(body);
      return send({ verified: true });
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
const { MemoryRouter, useNavigate } = await import('react-router-dom');
const { Tolgee, TolgeeProvider, FormatSimple } = await import('@tolgee/react');
const { AppContext } = await import('@_linked/server-utils/components/AppContext');
const libDir = new URL('../lib/esm/', import.meta.url);
const { ProvideAuth } = await import(new URL('hooks/useAuth.js', libDir));
const VerifyEmailCallback = (await import(new URL('components/VerifyEmailCallback.js', libDir)))
  .default;

const tolgee = Tolgee().use(FormatSimple()).init({ language: 'en', staticData: { en: {} } });
let root;
let navigate;
function CaptureNavigate() {
  navigate = useNavigate();
  return null;
}
const waitFor = async (check, what) => {
  for (let i = 0; i < 100; i++) {
    const value = check();
    if (value) return value;
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  assert.fail(`timed out waiting for ${what}`);
};

before(() => {
  root = createRoot(document.getElementById('root'));
});
after(async () => {
  await act(async () => root.unmount());
  server.close();
});

test('redeems a token once, and a new token on the same route', async () => {
  await act(async () => {
    root.render(
      React.createElement(
        AppContext.Provider,
        { value: {} },
        React.createElement(
          TolgeeProvider,
          { tolgee, fallback: 'loading' },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/auth/verify-email?token=first'] },
            React.createElement(
              ProvideAuth,
              null,
              React.createElement(CaptureNavigate),
              React.createElement(VerifyEmailCallback)
            )
          )
        )
      )
    );
  });
  await waitFor(() => verifyCalls.length === 1, 'the first token to be redeemed');
  // a re-render with the same token does not redeem it again
  await act(async () => navigate('/auth/verify-email?token=first&again=1'));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  assert.equal(verifyCalls.length, 1);
  await act(async () => navigate('/auth/verify-email?token=second'));
  await waitFor(() => verifyCalls.length === 2, 'the second token to be redeemed');
  assert.ok(verifyCalls[0].includes('first'));
  assert.ok(verifyCalls[1].includes('second'));
});
