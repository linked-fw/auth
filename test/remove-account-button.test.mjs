// RemoveAccountButton in jsdom: which proof the dialog asks for, and that a wrong one keeps the
// dialog open with the error. Renders the BUILT component, with Server.call going over HTTP to a
// tiny fake backend.
import './cssStub.mjs';
import { test, before, after, beforeEach } from 'node:test';
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
// Radix dispatches its own events with the global constructors: they must be jsdom's
for (const name of ['HTMLElement', 'Node', 'Element', 'MutationObserver', 'getComputedStyle']) {
  globalThis[name] ??= dom.window[name];
}
for (const name of ['Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent']) {
  globalThis[name] = dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// --- fake backend -----------------------------------------------------------------------------
let methods = ['password'];
const removeCalls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (obj) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (req.url.endsWith('/getReauthenticationMethods')) return send({ methods });
    if (req.url.endsWith('/removeAccount')) {
      removeCalls.push(body);
      return send({
        error: 'That confirmation did not match this account.',
        action: 'reauthenticate',
        methods,
      });
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
const { Tolgee, TolgeeProvider, FormatSimple } = await import('@tolgee/react');
const { AppContext } = await import('@_linked/server-utils/components/AppContext');
const libDir = new URL('../lib/esm/', import.meta.url);
const { ProvideAuth } = await import(new URL('hooks/useAuth.js', libDir));
const { RemoveAccountButton } = await import(
  new URL('components/RemoveAccountButton.js', libDir)
);

const tolgee = Tolgee().use(FormatSimple()).init({ language: 'en', staticData: { en: {} } });
let root;
async function render(props = {}) {
  await act(async () => {
    root.render(
      React.createElement(
        AppContext.Provider,
        { value: {} },
        React.createElement(
          TolgeeProvider,
          { tolgee, fallback: 'loading' },
          React.createElement(ProvideAuth, null, React.createElement(RemoveAccountButton, props))
        )
      )
    );
  });
}

const buttons = () => [...document.body.querySelectorAll('button')];
const button = (text) => buttons().find((b) => b.textContent.includes(text));
const waitFor = async (check, what) => {
  for (let i = 0; i < 100; i++) {
    const value = check();
    if (value) return value;
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  assert.fail(`timed out waiting for ${what}`);
};
async function openDialog() {
  const open = await waitFor(() => button('Delete Profile'), 'the delete button');
  await act(async () => open.click());
  return waitFor(() => document.body.querySelector('[role="alertdialog"]'), 'the dialog');
}

before(() => {
  root = createRoot(document.getElementById('root'));
});
beforeEach(async () => {
  await act(async () => root.render(null));
  removeCalls.length = 0;
});
after(async () => {
  await act(async () => root.unmount());
  server.close();
});

test('a password account sees a password field, and confirm waits for it', async () => {
  methods = ['password'];
  await render();
  const dialog = await openDialog();
  assert.ok(dialog.querySelector('input[type="password"]'), 'password field');
  assert.equal(button('Yes, delete my account').disabled, true, 'confirm disabled until filled');
  assert.equal(button('Confirm with'), undefined, 'no provider button');
});

test('a wrong password keeps the dialog open with the error', async () => {
  methods = ['password'];
  await render();
  const dialog = await openDialog();
  const input = dialog.querySelector('input[type="password"]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(input, 'wrong-pw');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const confirm = button('Yes, delete my account');
  assert.equal(confirm.disabled, false);
  await act(async () => confirm.click());
  const alert = await waitFor(
    () => document.body.querySelector('[role="alertdialog"] [role="alert"]'),
    'the error'
  );
  assert.match(alert.textContent, /did not match/);
  assert.ok(document.body.querySelector('[role="alertdialog"]'), 'the dialog stays open');
  assert.equal(removeCalls.length, 1);
  assert.ok(removeCalls[0].includes('wrong-pw'), 'the password is sent as the proof');
});

test('an OAuth-only account sees "Confirm with Google", which deletes in the same click', async () => {
  methods = ['google'];
  const asked = [];
  await render({
    getOAuthSource: async (provider) => {
      asked.push(provider);
      return { authentication: { idToken: 'fresh-token' } };
    },
  });
  const dialog = await openDialog();
  assert.equal(dialog.querySelector('input[type="password"]'), null, 'no password field');
  const google = button('Confirm with Google');
  assert.ok(google, 'Confirm with Google');
  assert.equal(button('Yes, delete my account').disabled, true, 'the provider is the confirmation');
  await act(async () => google.click());
  await waitFor(() => removeCalls.length === 1, 'removeAccount');
  assert.deepEqual(asked, ['google']);
  assert.ok(removeCalls[0].includes('fresh-token'), 'the source is sent as the proof');
  assert.ok(removeCalls[0].includes('google'));
});

test('without getOAuthSource an OAuth-only account gets a hint and nothing to confirm', async () => {
  methods = ['apple'];
  await render();
  await openDialog();
  assert.equal(button('Confirm with Apple').disabled, true);
  assert.equal(button('Yes, delete my account').disabled, true);
});

test('an account with no methods deletes with only the session', async () => {
  methods = [];
  await render();
  const dialog = await openDialog();
  assert.equal(dialog.querySelector('input'), null, 'nothing to fill in');
  const confirm = button('Yes, delete my account');
  assert.equal(confirm.disabled, false);
  await act(async () => confirm.click());
  await waitFor(() => removeCalls.length === 1, 'removeAccount');
  assert.doesNotMatch(removeCalls[0], /password|provider/, 'no proof sent');
});
