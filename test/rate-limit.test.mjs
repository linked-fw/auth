// Rate limits on the calls that check a credential, send an email or create something.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No store: the
// account lookups are stubbed, so these tests check when a call is refused, not sign-in itself.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serving } from './serving.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'unit-test-secret-unit-test-secret';
process.env.SESSION_SECRET = 'unit-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

// connect-sqlite3 (express-session store) writes into <cwd>/data
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const rateLimit = await import(new URL('utils/rateLimit.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { AuthCredentialProvider } = await import(
  new URL('shapes/AuthCredentialProvider.js', libDir)
);
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');
const { LinkedEmail } = await import('@_linked/server-utils/utils/LinkedEmail');
const sessions = await import(new URL('utils/sessions.js', libDir));

const {
  MemoryRateLimitStore,
  consumeRateLimit,
  configureRateLimits,
  resetRateLimits,
  setRateLimitStore,
  parseRateLimit,
  resolveRateLimit,
  secondsUntilAllowed,
  clientIp,
  RATE_LIMITED_MESSAGE,
} = rateLimit;

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };
const MINUTE = 60_000;
const ENV_KEYS = [
  'AUTH_RATE_LIMIT',
  'AUTH_RATE_LIMIT_SIGNIN_IP',
  'AUTH_RATE_LIMIT_SIGNIN_ACCOUNT',
  'AUTH_RATE_LIMIT_PASSWORD_RESET_REQUEST_ACCOUNT',
];

/** A provider whose account lookups find nothing, so a sign-in that runs fails quickly. */
class TestProvider extends AuthBackendProvider {
  async getPasswordForUser() {
    return null;
  }
}

/** An HTTP request from `ip`, with a response that records its headers. */
function requestFrom(ip, extra = {}) {
  const headers = {};
  return {
    ip,
    headers: {},
    cookies: {},
    res: {
      headers,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      cookie() {},
      clearCookie() {},
    },
    ...extra,
  };
}

function providerFor(request, Provider = TestProvider) {
  return serving(new Provider(null, fakeLincdServer), request);
}

beforeEach(() => {
  resetRateLimits();
  for (const key of ENV_KEYS) delete process.env[key];
  sessions.setRefreshSessionStore(new sessions.MemoryRefreshSessionStore());
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
  // no account exists for any email
  mock.method(UserAccount, 'select', () => ({ where: () => ({ one: async () => null }) }));
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  mock.restoreAll();
});

// ---- the limiter ----

test('a sliding window allows max attempts, then refuses with a retry delay', async () => {
  configureRateLimits({ signin: { ip: { max: 3, windowSeconds: 60 }, account: null } });
  const t0 = 10 * MINUTE; // the start of a window
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await consumeRateLimit('signin', { ip: '1.1.1.1' }, t0 + i), {
      limited: false,
    });
  }
  const refused = await consumeRateLimit('signin', { ip: '1.1.1.1' }, t0 + 3);
  assert.equal(refused.limited, true);
  assert.equal(refused.kind, 'ip');
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 120, `${refused.retryAfter}`);
  // another address has its own budget
  assert.equal((await consumeRateLimit('signin', { ip: '2.2.2.2' }, t0 + 4)).limited, false);
});

test('the previous window still counts, weighted by how much of it overlaps', async () => {
  configureRateLimits({ signin: { ip: { max: 4, windowSeconds: 60 }, account: null } });
  const t0 = 10 * MINUTE;
  for (let i = 0; i < 4; i++) await consumeRateLimit('signin', { ip: 'a' }, t0 + 59_000);
  // 6s into the next window, 90% of the previous 4 still counts: 3.6 + 1 > 4
  assert.equal((await consumeRateLimit('signin', { ip: 'a' }, t0 + 66_000)).limited, true);
  // at 45s in, 25% of 4 = 1, plus the 1 refused attempt counted above and this one = 3 <= 4
  assert.equal((await consumeRateLimit('signin', { ip: 'a' }, t0 + 105_000)).limited, false);
});

test('two windows later everything has expired', async () => {
  configureRateLimits({ signin: { ip: { max: 1, windowSeconds: 60 }, account: null } });
  const t0 = 10 * MINUTE;
  await consumeRateLimit('signin', { ip: 'a' }, t0);
  assert.equal((await consumeRateLimit('signin', { ip: 'a' }, t0 + 1)).limited, true);
  assert.equal((await consumeRateLimit('signin', { ip: 'a' }, t0 + 2 * MINUTE)).limited, false);
});

test('secondsUntilAllowed: in this window, or in the next one', () => {
  // previous window full (10), one attempt in this one, max 10: one more fits once 20% of the
  // previous window has slid out
  assert.equal(secondsUntilAllowed(10, 1, 10, MINUTE, 0), 12); // f >= 1 - 8/10 = 0.2
  // max 1, one attempt: the attempt has to slide out of the window entirely
  assert.equal(secondsUntilAllowed(0, 1, 1, MINUTE, 30_000), 90);
  // never below one second
  assert.equal(secondsUntilAllowed(0, 0, 5, MINUTE, MINUTE), 1);
});

test('the account and the address are each limited, and both are counted', async () => {
  configureRateLimits({
    signin: { ip: { max: 100, windowSeconds: 60 }, account: { max: 2, windowSeconds: 60 } },
  });
  const t = 10 * MINUTE;
  await consumeRateLimit('signin', { ip: 'a', account: 'ada@x.test' }, t);
  await consumeRateLimit('signin', { ip: 'b', account: 'ada@x.test' }, t);
  const refused = await consumeRateLimit('signin', { ip: 'c', account: 'ada@x.test' }, t);
  assert.equal(refused.limited, true);
  assert.equal(refused.kind, 'account');
  assert.equal((await consumeRateLimit('signin', { ip: 'c', account: 'bob@x.test' }, t)).limited, false);
});

test('AUTH_RATE_LIMIT=off turns every limit off', async () => {
  configureRateLimits({ signin: { ip: { max: 1, windowSeconds: 60 } } });
  process.env.AUTH_RATE_LIMIT = 'off';
  for (let i = 0; i < 5; i++) {
    assert.equal((await consumeRateLimit('signin', { ip: 'a' })).limited, false);
  }
});

test('an environment variable overrides one limit, and wins over configureRateLimits', () => {
  configureRateLimits({ signin: { ip: { max: 3, windowSeconds: 10 } } });
  assert.deepEqual(resolveRateLimit('signin', 'ip'), { max: 3, windowSeconds: 10 });
  process.env.AUTH_RATE_LIMIT_SIGNIN_IP = '20/300';
  assert.deepEqual(resolveRateLimit('signin', 'ip'), { max: 20, windowSeconds: 300 });
  process.env.AUTH_RATE_LIMIT_SIGNIN_IP = 'off';
  assert.equal(resolveRateLimit('signin', 'ip'), null);
  process.env.AUTH_RATE_LIMIT_PASSWORD_RESET_REQUEST_ACCOUNT = '1/60';
  assert.deepEqual(resolveRateLimit('passwordResetRequest', 'account'), {
    max: 1,
    windowSeconds: 60,
  });
  // the defaults
  assert.deepEqual(resolveRateLimit('signin', 'account'), { max: 5, windowSeconds: 60 });
  assert.deepEqual(resolveRateLimit('passwordResetRequest', 'ip'), { max: 10, windowSeconds: 3600 });
});

test('parseRateLimit', () => {
  assert.deepEqual(parseRateLimit('5/60'), { max: 5, windowSeconds: 60 });
  assert.deepEqual(parseRateLimit(' 5 / 60 '), { max: 5, windowSeconds: 60 });
  assert.equal(parseRateLimit('0'), null);
  assert.equal(parseRateLimit('OFF'), null);
  assert.equal(parseRateLimit('0/60'), null);
  assert.equal(parseRateLimit(undefined), undefined);
  assert.equal(parseRateLimit(''), undefined);
  assert.equal(parseRateLimit('lots'), undefined);
});

test('the memory store drops expired counters, and the oldest beyond maxKeys', () => {
  let now = 0;
  const store = new MemoryRateLimitStore({ maxKeys: 3, sweepEveryMs: 1000, now: () => now });
  store.increment('a', 500);
  store.increment('b', 5000);
  assert.equal(store.get('a'), 1);
  now = 1000;
  assert.equal(store.get('a'), 0, 'expired');
  store.increment('c', 5000); // sweeps: 'a' is gone
  assert.equal(store.size, 2);
  store.increment('d', 5000);
  store.increment('e', 5000); // at maxKeys: the oldest, 'b', is dropped
  assert.ok(store.size <= 3, `${store.size} keys`);
  assert.equal(store.get('b'), 0);
  assert.equal(store.get('e'), 1);
});

test('a custom store receives every counter', async () => {
  const seen = [];
  const counts = new Map();
  setRateLimitStore({
    increment: async (key, ttlMs) => {
      seen.push([key, ttlMs]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts.get(key);
    },
    get: async (key) => counts.get(key) ?? 0,
  });
  await consumeRateLimit('signin', { ip: '9.9.9.9', account: 'ada@x.test' });
  assert.equal(seen.length, 2);
  assert.match(seen[0][0], /^auth:signin:ip:60:9\.9\.9\.9:\d+$/);
  assert.match(seen[1][0], /^auth:signin:account:60:ada@x\.test:\d+$/);
  assert.equal(seen[0][1], 2 * MINUTE);
});

test('clientIp uses what Express resolved, never X-Forwarded-For', () => {
  assert.equal(clientIp({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6' } }), '10.0.0.1');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6' }, socket: { remoteAddress: '10.0.0.2' } }), '10.0.0.2');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6' } }), null);
  assert.equal(clientIp(undefined), null);
});

// ---- the provider methods ----

test('signinWithPassword: the 6th attempt for one email is refused, from any address', async () => {
  const results = [];
  for (let i = 0; i < 6; i++) {
    const provider = providerFor(requestFrom(`10.0.0.${i}`));
    results.push(await provider.signinWithPassword('Ada@Example.test ', 'guess' + i));
  }
  for (const result of results.slice(0, 5)) {
    assert.notEqual(result.action, 'rate_limited');
  }
  assert.deepEqual(results[5], {
    error: RATE_LIMITED_MESSAGE,
    action: 'rate_limited',
    retryAfter: results[5].retryAfter,
  });
  assert.ok(results[5].retryAfter >= 1);
  // the same email, spelled differently, shares the budget
  const again = await providerFor(requestFrom('10.0.1.1')).signinWithPassword('ada@example.test', 'x');
  assert.equal(again.action, 'rate_limited');
});

test('signinWithPassword: one address is refused after 10 attempts across emails', async () => {
  const request = requestFrom('203.0.113.7');
  const provider = providerFor(request);
  for (let i = 0; i < 10; i++) {
    const result = await provider.signinWithPassword(`user${i}@example.test`, 'guess');
    assert.notEqual(result.action, 'rate_limited', `attempt ${i + 1}`);
  }
  const refused = await provider.signinWithPassword('user99@example.test', 'guess');
  assert.equal(refused.action, 'rate_limited');
  assert.equal(request.res.headers['retry-after'], String(refused.retryAfter));
});

test('a limited answer is the same whether the account exists or not', async () => {
  configureRateLimits({ signin: { ip: null, account: { max: 1, windowSeconds: 60 } } });
  // 'ada' has an account, 'nobody' has none
  mock.method(UserAccount, 'select', () => ({
    where: () => ({ one: async () => null }),
  }));
  const credentials = [{ id: 'c1', passwordHash: '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv', credentialOf: { id: 'p1' } }];
  class ProviderWithAda extends AuthBackendProvider {
    async getPasswordForUser(user) {
      return user && credentials[0];
    }
  }
  const exists = providerFor(requestFrom('1.1.1.1'), ProviderWithAda);
  await exists.signinWithPassword('ada@example.test', 'wrong');
  const limitedExisting = await exists.signinWithPassword('ada@example.test', 'wrong');
  const missing = providerFor(requestFrom('1.1.1.1'));
  await missing.signinWithPassword('nobody@example.test', 'wrong');
  const limitedMissing = await missing.signinWithPassword('nobody@example.test', 'wrong');
  assert.equal(limitedExisting.action, 'rate_limited');
  assert.equal(limitedMissing.action, 'rate_limited');
  assert.deepEqual(
    { ...limitedExisting, retryAfter: 0 },
    { ...limitedMissing, retryAfter: 0 }
  );
});

test('sendResetPasswordLink: three emails an hour per address asked for, then no email', async () => {
  const sent = [];
  mock.method(LinkedEmail, 'send', async (options) => sent.push(options));
  // an account without a password yet: a credential is created for the link
  mock.method(UserAccount, 'select', () => ({
    where: () => ({
      one: async () => ({ id: 'acc', email: 'ada@example.test', accountOf: { id: 'p1' } }),
    }),
  }));
  mock.method(AuthCredential, 'create', async () => ({ id: 'c1' }));
  class ResetProvider extends TestProvider {
    userShape = {
      select: () => ({ for: () => ({ one: async () => ({ id: 'p1', givenName: 'Ada' }) }) }),
    };
  }
  for (let i = 0; i < 3; i++) {
    const provider = providerFor(requestFrom(`10.1.0.${i}`), ResetProvider);
    assert.equal(await provider.sendResetPasswordLink('ada@example.test'), true);
  }
  const refused = await providerFor(requestFrom('10.1.0.9'), ResetProvider).sendResetPasswordLink(
    'ADA@example.test'
  );
  assert.equal(refused.action, 'rate_limited');
  assert.equal(sent.length, 3, 'the refused request sent no email');
});

test('resendEmailVerification: three emails an hour per account, from any address', async () => {
  const { RATE_LIMIT_DEFAULTS } = rateLimit;
  assert.deepEqual(RATE_LIMIT_DEFAULTS.emailVerificationRequest, {
    ip: { max: 10, windowSeconds: 3600 },
    account: { max: 3, windowSeconds: 3600 },
  });
  const sent = [];
  mock.method(LinkedEmail, 'send', async (options) => sent.push(options));
  // a person with one unverified credential, and an account with an email
  mock.method(AuthCredential, 'select', () => ({
    where: () => Promise.resolve([{ id: 'c1', passwordHash: 'h' }]),
  }));
  mock.method(AuthCredential, 'update', () => ({ for: async () => ({ id: 'c1' }) }));
  class ResendProvider extends TestProvider {
    accountShape = { select: () => ({ for: async () => ({ id: 'acc', email: 'ada@example.test' }) }) };
    userShape = {
      select: () => ({ for: () => ({ one: async () => ({ id: 'p1', givenName: 'Ada' }) }) }),
    };
  }
  const session = { user: { id: 'p1' }, userAccount: { id: 'acc' } };
  for (let i = 0; i < 3; i++) {
    const provider = providerFor(requestFrom(`10.3.0.${i}`, { linkedAuth: session }), ResendProvider);
    assert.deepEqual(await provider.resendEmailVerification(), { sent: true });
  }
  const refused = await providerFor(
    requestFrom('10.3.0.9', { linkedAuth: session }),
    ResendProvider
  ).resendEmailVerification();
  assert.equal(refused.action, 'rate_limited');
  assert.equal(sent.length, 3, 'the refused request sent no email');
});

test('verifyEmail: one address is refused after 10 attempts a minute', async () => {
  const { RATE_LIMIT_DEFAULTS } = rateLimit;
  assert.deepEqual(RATE_LIMIT_DEFAULTS.emailVerify, { ip: { max: 10, windowSeconds: 60 } });
  // no credential holds any token
  mock.method(AuthCredential, 'select', () => ({ where: () => ({ one: async () => null }) }));
  for (let i = 0; i < 10; i++) {
    const result = await providerFor(requestFrom('10.4.0.1')).verifyEmail(`guess-${i}`);
    assert.equal(result.action, 'resend_verification');
  }
  const refused = await providerFor(requestFrom('10.4.0.1')).verifyEmail('guess-x');
  assert.equal(refused.action, 'rate_limited');
  const other = await providerFor(requestFrom('10.4.0.2')).verifyEmail('guess-y');
  assert.equal(other.action, 'resend_verification', 'another address is not limited');
});

test('a call outside any HTTP request is never limited', async () => {
  configureRateLimits({ signin: { ip: { max: 1, windowSeconds: 60 }, account: { max: 1, windowSeconds: 60 } } });
  const provider = new TestProvider(null, fakeLincdServer);
  for (let i = 0; i < 3; i++) {
    const result = await provider.signinWithPassword('ada@example.test', 'x');
    assert.notEqual(result.action, 'rate_limited');
  }
});

test('hasAuthCredential answers 429 when limited; userHasAuthCredential is not counted', async () => {
  configureRateLimits({ credentialLookup: { ip: { max: 2, windowSeconds: 60 } } });
  mock.method(AuthCredential, 'select', () => ({ where: () => ({ one: async () => null }) }));
  const request = requestFrom('10.2.0.1', { linkedAuth: { user: { id: 'p1' } } });
  const provider = providerFor(request, AuthCredentialProvider);
  for (let i = 0; i < 5; i++) await provider.userHasAuthCredential();
  await provider.hasAuthCredential({ id: 'p1' });
  await provider.hasAuthCredential({ id: 'p2' });
  await assert.rejects(provider.hasAuthCredential({ id: 'p3' }), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.message, RATE_LIMITED_MESSAGE);
    return true;
  });
});

test('validateToken: a refresh is limited by address, a valid access token is not counted', async () => {
  configureRateLimits({ tokenRefresh: { ip: { max: 2, windowSeconds: 60 } } });
  const provider = providerFor(requestFrom('10.3.0.1'));
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await provider.validateToken('not-a-real-refresh-token'));
  assert.notEqual(results[0].action, 'rate_limited');
  assert.notEqual(results[1].action, 'rate_limited');
  assert.equal(results[2].action, 'rate_limited');
});
