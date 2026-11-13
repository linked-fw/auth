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
const { MemoryRouter, Routes, Route, useLocation } = await import('react-router-dom');
const { AppContext } = await import('@_linked/server-utils/components/AppContext');
const libDir = new URL('../lib/esm/', import.meta.url);
const { ProvideAuth } = await import(new URL('hooks/useAuth.js', libDir));
const { RequireAuth, signinUrlFrom } = await import(
  new URL('components/RequireAuth.js', libDir)
);

const h = React.createElement;
let root;
// The sign-in page shows the URL it was opened with, so a test can read the `from` it got.
function SigninPage() {
  const location = useLocation();
  return h('p', null, `signin page at ${location.pathname}${location.search}${location.hash}`);
}

async function render(signinRoute, entry = '/') {
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
            { initialEntries: [entry] },
            h(
              Routes,
              null,
              h(Route, {
                path: '/*',
                element: h(RequireAuth, { signinRoute }, h('p', null, 'private page')),
              }),
              h(Route, {
                path: (signinRoute || '/signin').split('?')[0],
                element: h(SigninPage),
              })
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
  assert.match(document.body.textContent, /signin page at \/login\?/);
});

test('the redirect carries the guarded page, query and hash included, as from', async () => {
  await render(undefined, '/projects/p1/ontology?tab=classes&q=a%20b#term');
  await waitFor(() => document.body.textContent.includes('signin page'), 'the signin page');
  const shown = document.body.textContent.replace('signin page at ', '');
  const url = new URL(shown, 'http://localhost');
  assert.equal(url.pathname, '/signin');
  assert.equal(url.searchParams.get('from'), '/projects/p1/ontology?tab=classes&q=a%20b#term');
});

test("from is added to the signinRoute's own query", async () => {
  await render('/login?mode=code', '/deep/page');
  await waitFor(() => document.body.textContent.includes('signin page'), 'the signin route');
  const url = new URL(document.body.textContent.replace('signin page at ', ''), 'http://localhost');
  assert.equal(url.pathname, '/login');
  assert.equal(url.searchParams.get('mode'), 'code');
  assert.equal(url.searchParams.get('from'), '/deep/page');
});

test('signinUrlFrom merges from into the query, replaces an old from and keeps a hash', () => {
  assert.equal(signinUrlFrom('/signin', '/a?b=1'), '/signin?from=%2Fa%3Fb%3D1');
  assert.equal(signinUrlFrom('/signin?x=1', '/a'), '/signin?x=1&from=%2Fa');
  assert.equal(signinUrlFrom('/signin?from=%2Fold&x=1', '/new'), '/signin?from=%2Fnew&x=1');
  assert.equal(signinUrlFrom('/signin#top', '/a'), '/signin?from=%2Fa#top');
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
