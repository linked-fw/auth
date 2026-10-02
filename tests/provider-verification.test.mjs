import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import AppleHelper, {
  appleNonceMatches,
  buildAppleTokenAudiences,
} from '../lib/esm/helpers/apple.js';
import FacebookHelper from '../lib/esm/helpers/facebook.js';
import GoogleHelper, {
  buildGoogleTokenAudiences,
} from '../lib/esm/helpers/google.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const keyResolver = async () => publicKey.export({ type: 'spki', format: 'pem' });
const appleOptions = {
  nonce: 'expected-nonce',
  audiences: buildAppleTokenAudiences(
    'earth.peacegame.app',
    'earth.peacegame.web',
    'earth.peacegame.www'
  ),
  keyResolver,
};

function appleToken(overrides = {}, signOptions = {}) {
  return jwt.sign(
    {
      sub: 'apple-user-1',
      email: 'apple@example.com',
      email_verified: 'true',
      nonce: 'expected-nonce',
      ...overrides,
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'test-key',
      issuer: 'https://appleid.apple.com',
      audience: 'earth.peacegame.app',
      expiresIn: '5m',
      ...signOptions,
    }
  );
}

test('valid Apple web token returns trusted identity', async () => {
  assert.deepEqual(
    await AppleHelper.validateIdentityToken(appleToken(), appleOptions),
    {
      sub: 'apple-user-1',
      email: 'apple@example.com',
      emailVerified: true,
    }
  );
});

test('valid Apple native token accepts the iOS bundle audience', async () => {
  const identity = await AppleHelper.validateIdentityToken(
    appleToken({}, { audience: 'earth.peacegame.www' }),
    appleOptions
  );
  assert.equal(identity.sub, 'apple-user-1');
});

test('Apple audiences ignore blanks and duplicates', () => {
  assert.deepEqual(
    buildAppleTokenAudiences('app', ' ', undefined, 'app', 'ios'),
    ['app', 'ios']
  );
});

for (const [name, token, options = appleOptions] of [
  ['wrong issuer', appleToken({}, { issuer: 'https://attacker.invalid' })],
  ['wrong audience', appleToken({}, { audience: 'other.app' })],
  ['wrong nonce', appleToken({ nonce: 'wrong' })],
  ['missing nonce claim', appleToken({ nonce: undefined })],
  ['missing subject', appleToken({ sub: undefined })],
  ['unverified email', appleToken({ email_verified: 'false' })],
  ['empty audience list', appleToken(), { ...appleOptions, audiences: [] }],
]) {
  test(`Apple rejects ${name}`, async () => {
    await assert.rejects(() =>
      AppleHelper.validateIdentityToken(token, options)
    );
  });
}

test('Apple rejects expired, malformed, and unsupported-algorithm tokens', async () => {
  await assert.rejects(() =>
    AppleHelper.validateIdentityToken(
      appleToken({}, { expiresIn: -1 }),
      appleOptions
    )
  );
  await assert.rejects(() =>
    AppleHelper.validateIdentityToken('not-a-jwt', appleOptions)
  );
  const hsToken = jwt.sign(
    { sub: 'apple-user-1', nonce: 'expected-nonce' },
    'not-an-apple-key',
    { algorithm: 'HS256', keyid: 'test-key' }
  );
  await assert.rejects(() =>
    AppleHelper.validateIdentityToken(hsToken, appleOptions)
  );
});

test('Google audiences ignore blanks and duplicates', () => {
  assert.deepEqual(
    buildGoogleTokenAudiences('web', undefined, ' ', 'ios', 'web'),
    ['web', 'ios']
  );
});

test('Google accepts a verified server payload for a configured audience', async () => {
  let verificationInput;
  const payload = await GoogleHelper.validateIdToken('google-id-token', {
    audiences: ['web-client', 'ios-client'],
    verifier: async (input) => {
      verificationInput = input;
      return {
        iss: 'https://accounts.google.com',
        sub: 'google-user-1',
        aud: 'ios-client',
        iat: 1,
        exp: 2,
        email: 'google@example.com',
        email_verified: true,
      };
    },
  });
  assert.deepEqual(verificationInput, {
    idToken: 'google-id-token',
    audience: ['web-client', 'ios-client'],
  });
  assert.equal(payload?.sub, 'google-user-1');
  assert.equal(payload?.email, 'google@example.com');
});

for (const [name, payload] of [
  ['missing payload', undefined],
  ['missing subject', { email: 'a@example.com', email_verified: true }],
  ['missing email', { sub: 'subject', email_verified: true }],
  ['unverified email', { sub: 'subject', email: 'a@example.com', email_verified: false }],
]) {
  test(`Google rejects ${name}`, async () => {
    const result = await GoogleHelper.validateIdToken('token', {
      audiences: ['web-client'],
      verifier: async () => payload,
    });
    assert.equal(result, null);
  });
}

test('Google rejects missing token and empty audience configuration', async () => {
  assert.equal(
    await GoogleHelper.validateIdToken('', {
      audiences: ['web-client'],
      verifier: async () => {
        throw new Error('must not run');
      },
    }),
    null
  );
  assert.equal(
    await GoogleHelper.validateIdToken('token', {
      audiences: [],
      verifier: async () => {
        throw new Error('must not run');
      },
    }),
    null
  );
});

function facebookFetch({
  valid = true,
  appId = 'facebook-app',
  userId = 'facebook-user-1',
  profile = {},
  calls = [],
} = {}) {
  return async (url) => {
    calls.push(url);
    if (url.includes('/debug_token')) {
      return {
        ok: true,
        json: async () => ({
          data: { is_valid: valid, app_id: appId, user_id: userId },
        }),
      };
    }
    return {
      ok: profile !== null,
      json: async () =>
        profile === null
          ? { error: { message: 'profile failed' } }
          : {
              id: 'facebook-user-1',
              email: 'facebook@example.com',
              name: 'Facebook User',
              first_name: 'Facebook',
              last_name: 'User',
              picture: { data: { url: 'https://example.com/avatar.jpg' } },
              ...profile,
            },
    };
  };
}

test('Facebook accepts a valid token for the configured app', async () => {
  const identity = await FacebookHelper.validateAccessToken('user-token', {
    appId: 'facebook-app',
    appSecret: 'facebook-secret',
    fetch: facebookFetch(),
  });
  assert.equal(identity.id, 'facebook-user-1');
  assert.equal(identity.email, 'facebook@example.com');
  assert.equal(identity.givenName, 'Facebook');
});

test('Facebook rejects invalid token, wrong app, missing credentials, and bad profile', async () => {
  const base = { appId: 'facebook-app', appSecret: 'facebook-secret' };
  await assert.rejects(() =>
    FacebookHelper.validateAccessToken('token', {
      ...base,
      fetch: facebookFetch({ valid: false }),
    })
  );
  await assert.rejects(() =>
    FacebookHelper.validateAccessToken('token', {
      ...base,
      fetch: facebookFetch({ appId: 'other-app' }),
    })
  );
  await assert.rejects(() =>
    FacebookHelper.validateAccessToken('token', { fetch: facebookFetch() })
  );
  await assert.rejects(() =>
    FacebookHelper.validateAccessToken('token', {
      ...base,
      fetch: facebookFetch({ profile: null }),
    })
  );
  await assert.rejects(() =>
    FacebookHelper.validateAccessToken('token', {
      ...base,
      fetch: facebookFetch({ profile: { email: undefined } }),
    })
  );
});

test('Apple accepts the raw nonce when the token carries its SHA-256 hash', async () => {
  const raw = 'raw-client-nonce';
  const hashed = createHash('sha256').update(raw).digest('hex');
  const identity = await AppleHelper.validateIdentityToken(
    appleToken({ nonce: hashed }),
    { ...appleOptions, nonce: raw }
  );
  assert.equal(identity.sub, 'apple-user-1');
});

test('Apple nonce comparison rejects mismatches, blanks and the hash as input', () => {
  const raw = 'raw-client-nonce';
  const hashed = createHash('sha256').update(raw).digest('hex');
  assert.equal(appleNonceMatches(hashed, raw), true);
  assert.equal(appleNonceMatches(raw, raw), true);
  assert.equal(appleNonceMatches(hashed, 'other'), false);
  assert.equal(appleNonceMatches(undefined, raw), false);
  assert.equal(appleNonceMatches('', ''), false);
  // Supplying the token's own (hashed) claim must not satisfy a hashed check
  // by hashing it again.
  assert.equal(appleNonceMatches(hashed, createHash('sha256').update(hashed).digest('hex')), false);
});

test('Facebook verifies the token with the app token before asking for the profile', async () => {
  const calls = [];
  await FacebookHelper.validateAccessToken('user-token', {
    appId: 'facebook-app',
    appSecret: 'facebook-secret',
    fetch: facebookFetch({ calls }),
  });
  assert.equal(calls.length, 2);
  const debug = new URL(calls[0]);
  assert.equal(debug.pathname, '/debug_token');
  assert.equal(debug.searchParams.get('input_token'), 'user-token');
  assert.equal(debug.searchParams.get('access_token'), 'facebook-app|facebook-secret');
  assert.equal(new URL(calls[1]).pathname, '/me');
});

test('Facebook never asks /me about a token debug_token rejected', async () => {
  const calls = [];
  await assert.rejects(() =>
    FacebookHelper.validateAccessToken('user-token', {
      appId: 'facebook-app',
      appSecret: 'facebook-secret',
      fetch: facebookFetch({ valid: false, calls }),
    })
  );
  assert.equal(calls.length, 1);
});

test('Facebook rejects a profile that is not the token user, or a token without a user', async () => {
  const base = { appId: 'facebook-app', appSecret: 'facebook-secret' };
  await assert.rejects(() =>
    FacebookHelper.validateAccessToken('token', {
      ...base,
      fetch: facebookFetch({ userId: 'someone-else' }),
    })
  );
  await assert.rejects(() =>
    FacebookHelper.validateAccessToken('token', {
      ...base,
      fetch: facebookFetch({ userId: null }),
    })
  );
  await assert.rejects(() =>
    FacebookHelper.validateAccessToken('token', {
      ...base,
      fetch: facebookFetch({ valid: 'true' }),
    })
  );
});

test('a rejected Google token is not written to the log', async () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.secret-payload.secret-signature';
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    const result = await GoogleHelper.validateIdToken(token, {
      audiences: ['client'],
      verifier: async () => {
        // google-auth-library really does this: 'Invalid token signature: ' + jwt
        throw new Error('Invalid token signature: ' + token);
      },
    });
    assert.equal(result, null);
  } finally {
    console.error = original;
  }
  assert.ok(logged.length > 0);
  for (const line of logged) assert.doesNotMatch(line, /secret-payload/);
});
