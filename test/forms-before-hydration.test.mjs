// The server HTML of auth's forms: a submit before React hydrates must post the form, so the
// email and password travel in the request body and never in the URL. Server-renders the BUILT
// components and checks every <form> they emit.
import './cssStub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT ??= 'http://127.0.0.1:1';

const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const { Tolgee, TolgeeProvider, FormatSimple } = await import('@tolgee/react');
const { AppContext } = await import('@_linked/server-utils/components/AppContext');
const libDir = new URL('../lib/esm/', import.meta.url);
const component = async (name) => {
  const mod = await import(new URL(`components/${name}.js`, libDir));
  return mod.default ?? mod[name];
};
const { ProvideAuth } = await import(new URL('hooks/useAuth.js', libDir));

const tolgee = Tolgee().use(FormatSimple()).init({ language: 'en', staticData: { en: {} } });

function serverHtml(Component, props = {}, url = '/') {
  return renderToString(
    React.createElement(
      AppContext.Provider,
      { value: {} },
      React.createElement(
        TolgeeProvider,
        { tolgee, ssr: { language: 'en', staticData: { en: {} } } },
        React.createElement(
          MemoryRouter,
          { initialEntries: [url] },
          React.createElement(ProvideAuth, null, React.createElement(Component, props))
        )
      )
    )
  );
}

const forms = [
  ['SigninWithPasswordForm', { startWithInputField: true }],
  ['SigninWithCodeForm', {}],
  ['SigninWithCodeForm', {}, '/?code=12345678'],
  ['CreateAccountForm', {}],
  ['ForgotPasswordForm', {}],
  ['CreateNewPasswordForm', {}],
];

for (const [name, props, url] of forms) {
  test(`${name}${url ? ` (${url})` : ''}: every form in the server HTML posts`, async () => {
    const html = serverHtml(await component(name), props, url);
    const tags = html.match(/<form\b[^>]*>/g) ?? [];
    assert.ok(tags.length > 0, `${name} renders a <form>`);
    for (const tag of tags) {
      assert.match(tag, /\smethod="post"/, `${name}: ${tag}`);
      assert.doesNotMatch(tag, /\saction=/, `${name} posts to the page itself: ${tag}`);
    }
  });
}
