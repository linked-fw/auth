// SigninWithCodeForm in jsdom: the link in the email signs in once, and the typed flow sends a
// code, then signs in with it. Renders the BUILT component, with Server.call going over HTTP to a
// tiny fake backend.
import './cssStub.mjs';
import { test, beforeEach, afterEach, after } from 'node:test';
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
const calls = { sendSigninCode: [], signinWithCode: [] };
const SIGNED_IN = {
  auth: { user: { id: 'https://app.test/person/ada' }, userAccount: { id: 'https://app.test/account/ada' } },
  accessToken: 'access-token',
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (obj) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (req.url.endsWith('/sendSigninCode')) {
      calls.sendSigninCode.push(body);
      return send(true);
    }
    if (req.url.endsWith('/signinWithCode')) {
      calls.signinWithCode.push(body);
      return body.includes('123456')
        ? send(SIGNED_IN)
        : send({ error: 'This sign-in code is invalid or has expired.', action: 'invalid_code' });
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
const SigninWithCodeForm = (await import(new URL('components/SigninWithCodeForm.js', libDir)))
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

const loggedIn = [];
async function render(url) {
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
            { initialEntries: [url] },
            React.createElement(
              ProvideAuth,
              null,
              React.createElement(CaptureNavigate),
              React.createElement(SigninWithCodeForm, { onLoggedIn: (data) => loggedIn.push(data) })
            )
          )
        )
      )
    );
  });
}

/** Type `value` into `input` the way React sees a user type. */
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function submit(form) {
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  calls.sendSigninCode.length = 0;
  calls.signinWithCode.length = 0;
  loggedIn.length = 0;
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => {
  await act(async () => root.unmount());
});
after(() => server.close());

test('the link signs in once, and a new link on the same route signs in again', async () => {
  await render('/auth/signin-code?email=ada%40example.test&code=123456');
  await waitFor(() => loggedIn.length === 1, 'the link to sign in');
  assert.equal(calls.signinWithCode.length, 1);
  assert.ok(calls.signinWithCode[0].includes('ada@example.test'));
  // a re-render with the same link does not use the code again
  await act(async () => navigate('/auth/signin-code?email=ada%40example.test&code=123456&again=1'));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  assert.equal(calls.signinWithCode.length, 1);
  await act(async () => navigate('/auth/signin-code?email=ada%40example.test&code=999999'));
  await waitFor(() => calls.signinWithCode.length === 2, 'the new link to be used');
  await waitFor(() => document.querySelector('[role=alert]'), 'the refusal to show');
  assert.match(document.querySelector('[role=alert]').textContent, /invalid or has expired/);
});

test('typing an email sends a code, and typing the code signs in', async () => {
  await render('/signin');
  await waitFor(() => document.querySelector('input[type=email]'), 'the email field');
  await type(document.querySelector('input[type=email]'), 'ada@example.test');
  await submit(document.querySelector('form'));
  await waitFor(() => calls.sendSigninCode.length === 1, 'the code to be requested');
  assert.ok(calls.sendSigninCode[0].includes('ada@example.test'));

  const codeInput = await waitFor(
    () => document.querySelector('input[autocomplete=one-time-code]'),
    'the code field'
  );
  assert.match(document.body.textContent, /We sent a sign-in code to ada@example\.test/);
  await type(codeInput, '000000');
  await submit(document.querySelector('form'));
  await waitFor(() => document.querySelector('[role=alert]'), 'the refusal to show');
  assert.equal(loggedIn.length, 0);

  await type(document.querySelector('input[autocomplete=one-time-code]'), '123456');
  await submit(document.querySelector('form'));
  await waitFor(() => loggedIn.length === 1, 'the sign-in');
  assert.equal(calls.signinWithCode.length, 2);
  assert.ok(calls.signinWithCode[1].includes('ada@example.test'));
});
