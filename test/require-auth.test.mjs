// RequireAuth in jsdom: a visitor without a session is sent to the sign-in route once validation
// ends, the way a full page load after signout plays out; and what it shows while validating.
// Renders the BUILT component.
import './cssStub.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'http://127.0.0.1:1';

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { MemoryRouter, Routes, Route } = await import('react-router-dom');
const { AppContext } = await import('@_linked/server-utils/components/AppContext');
const libDir = new URL('../lib/esm/', import.meta.url);
const { ProvideAuth } = await import(new URL('hooks/useAuth.js', libDir));
const { RequireAuth } = await import(new URL('components/RequireAuth.js', libDir));

const h = React.createElement;
let root;
async function render(signinRoute) {
  await act(async () => {
    root.render(
      h(
        AppContext.Provider,
        { value: {} },
        h(
          ProvideAuth,
          null,
          h(
            MemoryRouter,
            { initialEntries: ['/'] },
            h(
              Routes,
              null,
              h(Route, {
                path: '/',
                element: h(RequireAuth, { signinRoute }, h('p', null, 'private page')),
              }),
              h(Route, { path: signinRoute || '/signin', element: h('p', null, 'signin page') })
            )
          )
        )
      )
    );
  });
}

const waitFor = async (check, what) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  assert.fail(`timed out waiting for ${what}; page shows "${document.body.textContent}"`);
};

before(() => {
  root = createRoot(document.getElementById('root'));
});
beforeEach(async () => {
  await act(async () => root.render(null));
  document.cookie = 'linkedAuthSession=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});
after(async () => {
  await act(async () => root.unmount());
});

test('a visitor with no session is redirected to /signin once validation ends', async () => {
  await render();
  await waitFor(() => document.body.textContent.includes('signin page'), 'the signin page');
  assert.doesNotMatch(document.body.textContent, /private page/);
});

test('the redirect goes to the given signinRoute', async () => {
  await render('/login');
  await waitFor(() => document.body.textContent.includes('signin page'), 'the signin route');
});

// A server render never finishes validating, so it shows the loading state
function serverRender({ providerLoading, ownLoading } = {}) {
  return renderToString(
    h(
      AppContext.Provider,
      { value: {} },
      h(
        ProvideAuth,
        { renderLoading: providerLoading },
        h(
          MemoryRouter,
          { initialEntries: ['/'] },
          h(
            Routes,
            null,
            h(Route, {
              path: '/',
              element: h(RequireAuth, { renderLoading: ownLoading }, h('p', null, 'private page')),
            })
          )
        )
      )
    )
  );
}

test("while validating it shows ProvideAuth's renderLoading", () => {
  const html = serverRender({ providerLoading: () => h('p', null, 'app loader') });
  assert.match(html, /app loader/);
  assert.doesNotMatch(html, /private page/);
});

test('its own renderLoading wins over the provider one', () => {
  const html = serverRender({
    providerLoading: () => h('p', null, 'app loader'),
    ownLoading: () => h('p', null, 'own loader'),
  });
  assert.match(html, /own loader/);
  assert.doesNotMatch(html, /app loader/);
});

test('with no renderLoading anywhere it shows nothing', () => {
  assert.equal(serverRender(), '');
});
