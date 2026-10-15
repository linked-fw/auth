// The Client ID Document and the sign-in theme: building the document from configuration, and
// validateClientTheme keeping valid theme values and dropping the rest.
//
// The serving tests run over real HTTP against an Express app with the provider's middleware.
// Uses the BUILT package in lib/.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'client-id-test-secret-client-id-test-secret';
process.env.SESSION_SECRET = 'client-id-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-client-id-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const {
  SIGNIN_THEME_KEY,
  SIGNIN_THEME_FONTS,
  SIGNIN_THEME_LAYOUTS,
  SIGNIN_THEME_SCHEMES,
  SIGNIN_THEME_JSON_SCHEMA,
  buildClientIdDocument,
  validateClientTheme,
  isThemeColor,
} = await import(new URL('utils/clientIdDocument.js', libDir));

const validTheme = {
  layout: 'two-column',
  colors: {
    primary: '#1a73e8',
    accent: 'rgb(255, 128, 0)',
    background: 'hsl(210 20% 98% / 0.9)',
    panel: 'white',
    text: '#222',
  },
  font: 'Inter',
  scheme: 'dark',
  brand: { name: 'Create.Now', logoUri: 'https://create.now/logo.svg' },
  panelArt: 'https://create.now/art/bow.svg',
};

const config = {
  clientName: 'Create.Now',
  logoUri: 'https://create.now/logo.svg',
  policyUri: 'https://create.now/privacy',
  tosUri: 'https://create.now/terms',
  theme: validTheme,
};

const themeOf = (theme) => ({ [SIGNIN_THEME_KEY]: theme });

test('the document is built from the configuration and SITE_ROOT', () => {
  const { document, problems } = buildClientIdDocument(config, 'https://create.now');
  assert.deepEqual(problems, []);
  assert.deepEqual(document, {
    '@context': ['https://www.w3.org/ns/solid/oidc-context.jsonld'],
    client_id: 'https://create.now/.well-known/linked-client.jsonld',
    client_name: 'Create.Now',
    redirect_uris: ['https://create.now/auth/oidc/callback'],
    client_uri: 'https://create.now',
    logo_uri: 'https://create.now/logo.svg',
    policy_uri: 'https://create.now/privacy',
    tos_uri: 'https://create.now/terms',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid webid email',
    token_endpoint_auth_method: 'none',
    'https://linked.cm/ns/signin#theme': validTheme,
  });
});

test('optional fields are left out; clientUri overrides SITE_ROOT', () => {
  const { document } = buildClientIdDocument(
    { clientName: 'App', clientUri: 'https://app.example/home' },
    'https://app.example'
  );
  assert.equal(document.client_uri, 'https://app.example/home');
  for (const key of ['logo_uri', 'policy_uri', 'tos_uri', SIGNIN_THEME_KEY]) {
    assert.ok(!(key in document), `${key} should be absent`);
  }
});

test('a trailing slash on SITE_ROOT is stripped once', () => {
  const { document } = buildClientIdDocument({ clientName: 'App' }, 'https://app.example/');
  assert.equal(document.client_id, 'https://app.example/.well-known/linked-client.jsonld');
  assert.deepEqual(document.redirect_uris, ['https://app.example/auth/oidc/callback']);
  assert.equal(document.client_uri, 'https://app.example');
});

test('http: is accepted for localhost only', () => {
  const { document } = buildClientIdDocument({ clientName: 'App' }, 'http://localhost:4040');
  assert.equal(document.client_id, 'http://localhost:4040/.well-known/linked-client.jsonld');
  for (const root of ['http://app.example', 'http://127.0.0.1:4040', 'ftp://app.example', '', undefined]) {
    assert.throws(() => buildClientIdDocument({ clientName: 'App' }, root), /SITE_ROOT/, String(root));
  }
});

test('configured URLs follow the same rule, and a client name is required', () => {
  assert.throws(
    () => buildClientIdDocument({ clientName: 'App', policyUri: 'http://app.example/p' }, 'https://app.example'),
    /policyUri/
  );
  assert.throws(
    () => buildClientIdDocument({ clientName: 'App', logoUri: 'javascript:alert(1)' }, 'https://app.example'),
    /logoUri/
  );
  assert.throws(() => buildClientIdDocument({}, 'https://app.example'), /clientName/);
});

test('extra redirect URIs are appended; custom schemes allowed, remote http: refused', () => {
  const { document } = buildClientIdDocument(
    { clientName: 'App', redirectUris: ['https://app.example/native/callback', 'com.example.app:/callback'] },
    'https://app.example'
  );
  assert.deepEqual(document.redirect_uris, [
    'https://app.example/auth/oidc/callback',
    'https://app.example/native/callback',
    'com.example.app:/callback',
  ]);
  assert.throws(
    () => buildClientIdDocument({ clientName: 'App', redirectUris: ['http://evil.example/cb'] }, 'https://app.example'),
    /redirect URI/
  );
  assert.throws(
    () => buildClientIdDocument({ clientName: 'App', redirectUris: ['not a url'] }, 'https://app.example'),
    /redirect URI/
  );
});

test('invalid configured theme values are left out of the document and returned', () => {
  const { document, problems } = buildClientIdDocument(
    { clientName: 'App', theme: { ...validTheme, colors: { primary: 'url(https://x/y.png)', text: '#000' } } },
    'https://app.example'
  );
  assert.deepEqual(document[SIGNIN_THEME_KEY].colors, { text: '#000' });
  assert.deepEqual(problems, [
    { path: 'colors.primary', value: 'url(https://x/y.png)', reason: 'not a plain CSS colour' },
  ]);
});

test('a valid theme is kept intact', () => {
  assert.deepEqual(validateClientTheme(themeOf(validTheme)), { theme: validTheme, problems: [] });
});

test('a document without a theme, or not an object, has no theme and no problems', () => {
  for (const doc of [{}, { client_id: 'x' }, null, undefined, 'text', []]) {
    assert.deepEqual(validateClientTheme(doc), { theme: undefined, problems: [] });
  }
});

test('a theme that is not an object is dropped whole', () => {
  for (const theme of ['dark', 42, null, ['card']]) {
    const { theme: kept, problems } = validateClientTheme(themeOf(theme));
    assert.equal(kept, undefined);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].path, '');
  }
});

test('colours: plain CSS colours pass, anything that could load or compute something does not', () => {
  const good = [
    '#fff', '#ffff', '#a1b2c3', '#a1b2c3d4', 'rgb(0,0,0)', 'rgba(0, 0, 0, 0.5)', 'rgb(0 0 0 / 50%)',
    'hsl(120deg 50% 50%)', 'hsla(120, 50%, 50%, .3)', 'rebeccapurple', 'transparent',
  ];
  const bad = [
    'url(https://evil.example/x.png)', 'var(--x)', 'calc(1px)', 'expression(alert(1))',
    'red; background: url(x)', '#ggg', '#12345', 'rgb(123)', 'rgb(0,0,0', 'notacolour',
    'RED', 'currentcolor', '', 42, null, { r: 0 }, 'rgb(1,2,3)'.padEnd(70, ' '),
  ];
  for (const value of good) assert.ok(isThemeColor(value), `should pass: ${value}`);
  for (const value of bad) assert.ok(!isThemeColor(value), `should fail: ${String(value)}`);
});

test('every invalid value is dropped and reported with its path; valid ones stay', () => {
  const { theme, problems } = validateClientTheme(
    themeOf({
      layout: 'sidebar',
      colors: { primary: 'url(x)', accent: '#0f0', glow: '#fff', text: 'var(--t)' },
      font: 'Comic Sans MS',
      scheme: 'sepia',
      brand: { name: '  ', logoUri: 'http://evil.example/logo.png', tagline: 'hi' },
      panelArt: 'data:image/svg+xml,<svg/>',
      css: 'body{}',
    })
  );
  assert.deepEqual(theme, { colors: { accent: '#0f0' } });
  assert.deepEqual(
    problems.map((p) => p.path).sort(),
    [
      'brand.logoUri', 'brand.name', 'brand.tagline', 'colors.glow', 'colors.primary', 'colors.text',
      'css', 'font', 'layout', 'panelArt', 'scheme',
    ]
  );
  for (const problem of problems) assert.ok(problem.reason, `${problem.path} has a reason`);
});

test('wrong types for nested objects are dropped', () => {
  const { theme, problems } = validateClientTheme(themeOf({ colors: '#fff', brand: 'Acme', font: 'Lato' }));
  assert.deepEqual(theme, { font: 'Lato' });
  assert.deepEqual(problems.map((p) => p.path), ['colors', 'brand']);
});

test('panel art and logo accept https: and localhost http:', () => {
  const { theme, problems } = validateClientTheme(
    themeOf({ panelArt: 'http://localhost:4040/art.svg', brand: { logoUri: 'https://cdn.example/l.png' } })
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(theme, {
    panelArt: 'http://localhost:4040/art.svg',
    brand: { logoUri: 'https://cdn.example/l.png' },
  });
});

test('a brand name is trimmed and limited in length', () => {
  assert.deepEqual(validateClientTheme(themeOf({ brand: { name: ' Acme ' } })).theme, { brand: { name: 'Acme' } });
  const { theme, problems } = validateClientTheme(themeOf({ brand: { name: 'x'.repeat(81) } }));
  assert.equal(theme, undefined);
  assert.equal(problems[0].path, 'brand.name');
});

test('the JSON Schema describes the same fields and lists as the validator', () => {
  const schema = SIGNIN_THEME_JSON_SCHEMA;
  assert.equal(schema.$id, SIGNIN_THEME_KEY);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(validTheme).sort());
  assert.deepEqual(schema.properties.layout.enum, [...SIGNIN_THEME_LAYOUTS]);
  assert.deepEqual(schema.properties.scheme.enum, [...SIGNIN_THEME_SCHEMES]);
  assert.deepEqual(schema.properties.font.enum, [...SIGNIN_THEME_FONTS]);
  assert.deepEqual(Object.keys(schema.properties.colors.properties).sort(), Object.keys(validTheme.colors).sort());
  const [patterned, named] = schema.$defs.color.anyOf;
  const pattern = new RegExp(patterned.pattern);
  for (const value of ['#fff', 'rgb(0 0 0 / 50%)', 'hsla(120, 50%, 50%, .3)']) assert.ok(pattern.test(value), value);
  for (const value of ['url(x)', 'var(--x)', 'red']) assert.ok(!pattern.test(value), value);
  assert.ok(named.enum.includes('white') && named.enum.includes('transparent'));
  const url = new RegExp(schema.$defs.webUrl.pattern);
  assert.ok(url.test('https://a.example/x.svg') && url.test('http://localhost:4040/x.svg'));
  assert.ok(!url.test('http://a.example/x.svg') && !url.test('data:image/svg+xml,<svg/>'));
  // JSON-serialisable as is, for tools that load it
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
});

test('the font allow-list includes the platform font and has no duplicates', () => {
  assert.ok(SIGNIN_THEME_FONTS.includes('system-ui'));
  assert.equal(new Set(SIGNIN_THEME_FONTS).size, SIGNIN_THEME_FONTS.length);
  assert.ok(Object.isFrozen(SIGNIN_THEME_FONTS));
});

// --- Serving -------------------------------------------------------------------------------

const { default: express } = await import('express');
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { Auth } = await import(new URL('utils/auth.js', libDir));

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };
const servers = [];
after(() => servers.forEach((s) => s.close()));

/** Starts an app with the provider set up, with `Auth.signinClient` and SITE_ROOT as given. */
async function startApp({ signinClient, siteRoot }) {
  Auth.signinClient = signinClient;
  process.env.SITE_ROOT = siteRoot;
  const app = express();
  app.lazyrouter();
  const provider = new AuthBackendProvider(app, fakeLincdServer);
  await provider.setupBeforeControllers();
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/** Runs `fn` with console.warn captured; returns what was warned. */
async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('a configured app serves its document as cacheable JSON-LD, without invalid theme values', async () => {
  let url;
  const warnings = await captureWarnings(async () => {
    url = await startApp({
      signinClient: { clientName: 'Create.Now', theme: { ...validTheme, font: 'Comic Sans MS' } },
      siteRoot: 'https://create.now/',
    });
  });
  assert.ok(
    warnings.some((w) => w.includes('Client ID Document') && w.includes('font') && w.includes('Comic Sans MS')),
    warnings.join('\n')
  );

  const res = await fetch(`${url}/.well-known/linked-client.jsonld`, { signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/ld\+json/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=600');
  const document = await res.json();
  assert.equal(document.client_id, 'https://create.now/.well-known/linked-client.jsonld');
  assert.deepEqual(document.redirect_uris, ['https://create.now/auth/oidc/callback']);
  const { font, ...rest } = validTheme;
  assert.deepEqual(document[SIGNIN_THEME_KEY], rest);
});

test('an app without sign-in config serves nothing at the path', async () => {
  const url = await startApp({ signinClient: undefined, siteRoot: 'https://app.example' });
  const res = await fetch(`${url}/.well-known/linked-client.jsonld`, { signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 404);
});

test('a SITE_ROOT the issuer would reject stops startup with a fatal error', async () => {
  await assert.rejects(
    startApp({ signinClient: { clientName: 'App' }, siteRoot: 'http://app.example' }),
    (err) => err.name === 'FatalConfigError' && err.fatal === true && /SITE_ROOT/.test(err.message)
  );
  Auth.signinClient = undefined;
});
