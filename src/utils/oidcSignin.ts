/**
 * The Solid-OIDC relying party: the redirect to an issuer and the exchange on the way back
 * (arch-08 §Protocol, in the Create Now repo). Login only: the issuer's tokens are read and
 * discarded, and the app starts its own session from the verified identity.
 *
 * - **begin:** authorization code flow with PKCE (`S256`), `state`, `nonce`, a fresh DPoP key whose
 *   thumbprint goes along as `dpop_jkt` (RFC 9449 §10), `login_hint`, optional `prompt=none` and a
 *   provider hint. It returns the URL and the pending sign-in, which the caller keeps server-side.
 * - **complete:** the code is exchanged with a DPoP proof; the ID token's signature is checked
 *   against the issuer's JWKS and its `iss`, `aud`, `exp`, `iat` and `nonce` are checked
 *   (openid-client). `webid` and `auth_time` are required, `email` when configured. Then the
 *   issuer check: `iss` must be a `solid:oidcIssuer` of the WebID's profile, unless the WebID is on
 *   the issuer's origin.
 *
 * Every request goes through a guarded fetch (see `guardedFetch.ts`), since the issuer and the
 * WebID come from user input. Results are returned, never thrown. Free of Express and the store.
 */
import * as client from 'openid-client';
import { createHash, webcrypto } from 'node:crypto';
import { createGuardedFetch } from './guardedFetch.js';
import { fetchOidcIssuers, isFetchableUrl } from './issuerDiscovery.js';

const { subtle } = webcrypto;

/** The DPoP key algorithm: ES256 on P-256, what Solid issuers support. */
const DPOP_KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** The scopes a login-only Solid-OIDC client asks for (contract 3). */
export const OIDC_SIGNIN_SCOPE = 'openid webid email';

export interface OidcRelyingPartyOptions {
  /** The app's `client_id`: the URL of its Client ID Document. */
  clientId: string;
  /** The callback URL, listed in the Client ID Document's `redirect_uris`. */
  redirectUri: string;
  /** Allow `http://` and loopback issuers and WebIDs, for development. Default `false`. */
  allowLocalhost?: boolean;
  /** Refuse an ID token without an `email` claim. Default `false`: other issuers may omit it. */
  requireEmail?: boolean;
  /** Deadline for each request to the issuer or the profile. Default 5000 ms. */
  timeoutMs?: number;
  /** How long an issuer's discovered metadata is reused. Default 10 minutes. */
  metadataTtlMs?: number;
  /** Replaces the guarded fetch (tests). Every request to the issuer and the profile uses it. */
  fetch?: typeof fetch;
  /** Clock in ms, for the metadata cache and the pending sign-in's age. Default `Date.now`. */
  now?: () => number;
}

/** A sign-in on its way to the issuer, kept server-side until the callback. Plain JSON. */
export interface PendingOidcSignin {
  state: string;
  /** The issuer the user was sent to; the ID token's `iss` must be this. */
  issuer: string;
  codeVerifier: string;
  nonce: string;
  /** The DPoP key pair, as JWKs, so the record can be stored. */
  dpopPublicJwk: JsonWebKey;
  dpopPrivateJwk: JsonWebKey;
  /** The email sent as `login_hint`, normalised; compared with the token's `email`. */
  loginHint?: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

export interface BeginOidcSigninOptions {
  issuer: string;
  /** An email, sent as `login_hint`. */
  loginHint?: string;
  /** `'none'` for a silent sign-in: the issuer answers `login_required` instead of asking. */
  prompt?: 'none';
  /** Sent as `provider_hint` (e.g. `google`); not standard, other issuers ignore it. */
  providerHint?: string;
}

export type BeginOidcSigninResult =
  | { ok: true; url: string; pending: PendingOidcSignin }
  /** `invalid_issuer`: not a URL this server fetches; `issuer_unreachable`: no usable metadata. */
  | { ok: false; error: 'invalid_issuer' | 'issuer_unreachable' };

/** What a completed sign-in proves. The issuer's tokens are not part of it. */
export interface VerifiedOidcIdentity {
  webId: string;
  issuer: string;
  /** The ID token's `sub`. */
  subject: string;
  /** When the user authenticated at the issuer, in seconds since the epoch. */
  authTime: number;
  email?: string;
  emailVerified?: boolean;
}

export type OidcSigninError =
  /** `prompt=none` and the user has no session at the issuer. */
  | 'login_required'
  /** `prompt=none` and the issuer needs the user (consent, account choice). */
  | 'interaction_required'
  /** The user or the issuer refused. */
  | 'access_denied'
  /** The issuer's metadata, keys or token endpoint could not be reached. */
  | 'issuer_unreachable'
  /** `iss` is not an issuer the WebID's profile names, or the profile could not be read. */
  | 'issuer_refused'
  /** The token response or the ID token failed a check (signature, `iss`, `aud`, `exp`, `nonce`). */
  | 'invalid_token'
  /** The ID token lacks `webid`, `auth_time`, or `email` when required. */
  | 'missing_claim'
  /** Anything else the issuer answered with. */
  | 'failed';

export type CompleteOidcSigninResult =
  | { ok: true; identity: VerifiedOidcIdentity }
  | { ok: false; error: OidcSigninError; detail?: string };

export interface OidcRelyingParty {
  begin(options: BeginOidcSigninOptions): Promise<BeginOidcSigninResult>;
  /**
   * @param pending - the record `begin` returned, found by the callback's `state`
   * @param callbackQuery - the query string the issuer sent the browser back with
   */
  complete(pending: PendingOidcSignin, callbackQuery: string | URLSearchParams): Promise<CompleteOidcSigninResult>;
  clearCache(): void;
}

/** The authorization errors that are answers, passed to the app as they are. */
const ANSWERED_ERRORS: Record<string, OidcSigninError> = {
  login_required: 'login_required',
  interaction_required: 'interaction_required',
  consent_required: 'interaction_required',
  account_selection_required: 'interaction_required',
  access_denied: 'access_denied',
};

/** Equal as issuer identifiers: exactly, or but for one trailing slash. */
export const sameIssuer = (a: string, b: string): boolean =>
  a === b || a.replace(/\/$/, '') === b.replace(/\/$/, '');

const originOf = (href: string): string | undefined => {
  try {
    return new URL(href).origin;
  } catch {
    return undefined;
  }
};

/** The RFC 7638 thumbprint of a P-256 public JWK, base64url. */
export const jwkThumbprint = (jwk: JsonWebKey): string =>
  createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');

const errorCodeOf = (error: unknown): string | undefined => {
  const value = (error as { error?: unknown; code?: unknown } | null)?.error;
  return typeof value === 'string' ? value : undefined;
};

/** The first cause in the chain, for a log line. Never includes a token. */
const describe = (error: unknown): string => {
  const parts: string[] = [];
  for (let e = error as { message?: unknown; cause?: unknown } | undefined, i = 0; e && i < 4; e = e.cause as typeof e, i++) {
    if (typeof e.message === 'string') parts.push(e.message);
  }
  return parts.join(': ') || String(error);
};

/** Whether openid-client failed reaching the issuer, as opposed to checking what it said. */
const isTransportError = (error: unknown): boolean => {
  for (let e = error as { name?: unknown; code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 6; e = e.cause as typeof e, i++) {
    if (e.name === 'BlockedAddressError' || e.name === 'RefusedUrlError' || e.name === 'AbortError' || e.name === 'TimeoutError') {
      return true;
    }
    if (e.name === 'TypeError' && (e as { message?: unknown }).message === 'fetch failed') return true;
  }
  return false;
};

export const createOidcRelyingParty = (options: OidcRelyingPartyOptions): OidcRelyingParty => {
  const allowLocalhost = options.allowLocalhost ?? false;
  const timeoutMs = options.timeoutMs ?? 5000;
  const metadataTtlMs = options.metadataTtlMs ?? 10 * 60 * 1000;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? createGuardedFetch({ allowLocalhost });
  const configurations = new Map<string, { at: number; config: Promise<client.Configuration> }>();

  const discover = async (issuer: string): Promise<client.Configuration> => {
    const cached = configurations.get(issuer);
    if (cached && now() - cached.at < metadataTtlMs) return cached.config;
    const insecure = new URL(issuer).protocol === 'http:';
    const config = client
      .discovery(
        new URL(issuer),
        options.clientId,
        { token_endpoint_auth_method: 'none', redirect_uris: [options.redirectUri] },
        client.None(),
        {
          execute: insecure ? [client.allowInsecureRequests] : [],
          [client.customFetch]: fetchImpl as client.CustomFetch,
          timeout: Math.ceil(timeoutMs / 1000),
        }
      )
      .then((discovered) => {
        // the ID token's signature is checked against the issuer's JWKS, not only trusted by TLS
        client.enableNonRepudiationChecks(discovered);
        return discovered;
      });
    configurations.set(issuer, { at: now(), config });
    // a failed discovery is not kept: the next sign-in asks again
    config.catch(() => {
      if (configurations.get(issuer)?.config === config) configurations.delete(issuer);
    });
    return config;
  };

  const begin = async (begin: BeginOidcSigninOptions): Promise<BeginOidcSigninResult> => {
    if (typeof begin?.issuer !== 'string' || !isFetchableUrl(begin.issuer, allowLocalhost)) {
      return { ok: false, error: 'invalid_issuer' };
    }
    let config: client.Configuration;
    try {
      config = await discover(begin.issuer);
    } catch (error) {
      console.warn(`[auth] OIDC sign-in: no usable metadata from ${begin.issuer}: ${describe(error)}`);
      return { ok: false, error: 'issuer_unreachable' };
    }

    const keyPair = (await subtle.generateKey(DPOP_KEY_ALGORITHM, true, ['sign', 'verify'])) as CryptoKeyPair;
    const dpopPublicJwk = await subtle.exportKey('jwk', keyPair.publicKey);
    const dpopPrivateJwk = await subtle.exportKey('jwk', keyPair.privateKey);
    const codeVerifier = client.randomPKCECodeVerifier();
    const pending: PendingOidcSignin = {
      state: client.randomState(),
      issuer: begin.issuer,
      codeVerifier,
      nonce: client.randomNonce(),
      dpopPublicJwk,
      dpopPrivateJwk,
      ...(begin.loginHint ? { loginHint: begin.loginHint } : {}),
      createdAt: now(),
    };

    const parameters: Record<string, string> = {
      redirect_uri: options.redirectUri,
      response_type: 'code',
      scope: OIDC_SIGNIN_SCOPE,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      dpop_jkt: jwkThumbprint(dpopPublicJwk),
    };
    if (begin.loginHint) parameters.login_hint = begin.loginHint;
    if (begin.prompt === 'none') parameters.prompt = 'none';
    if (begin.providerHint) parameters.provider_hint = begin.providerHint;

    return { ok: true, url: client.buildAuthorizationUrl(config, parameters).href, pending };
  };

  /** `iss` must be an issuer of the WebID's profile, unless the WebID is on the issuer's origin. */
  const checkIssuer = async (webId: string, issuer: string): Promise<string | null> => {
    if (!isFetchableUrl(webId, allowLocalhost)) return 'the WebID is not a URL this server fetches';
    const issuerOrigin = originOf(issuer);
    if (issuerOrigin && originOf(webId) === issuerOrigin) return null;
    const profile = await fetchOidcIssuers(webId, { allowLocalhost, timeoutMs, fetch: fetchImpl });
    if (profile.ok === false) return `the WebID's profile could not be read (${profile.reason})`;
    if (!profile.issuers.some((listed) => sameIssuer(listed, issuer))) {
      return "the WebID's profile does not name this issuer";
    }
    return null;
  };

  const complete = async (
    pending: PendingOidcSignin,
    callbackQuery: string | URLSearchParams
  ): Promise<CompleteOidcSigninResult> => {
    const callbackUrl = new URL(options.redirectUri);
    callbackUrl.search = new URLSearchParams(callbackQuery).toString();

    let config: client.Configuration;
    try {
      config = await discover(pending.issuer);
    } catch (error) {
      console.warn(`[auth] OIDC sign-in: no usable metadata from ${pending.issuer}: ${describe(error)}`);
      return { ok: false, error: 'issuer_unreachable' };
    }

    let claims: Record<string, unknown> | undefined;
    try {
      const keyPair = {
        publicKey: await subtle.importKey('jwk', pending.dpopPublicJwk, DPOP_KEY_ALGORITHM, true, ['verify']),
        privateKey: await subtle.importKey('jwk', pending.dpopPrivateJwk, DPOP_KEY_ALGORITHM, false, ['sign']),
      } as CryptoKeyPair;
      const tokens = await client.authorizationCodeGrant(
        config,
        callbackUrl,
        {
          pkceCodeVerifier: pending.codeVerifier,
          expectedState: pending.state,
          expectedNonce: pending.nonce,
          idTokenExpected: true,
        },
        undefined,
        { DPoP: client.getDPoPHandle(config, keyPair) }
      );
      claims = tokens.claims() as Record<string, unknown> | undefined;
    } catch (error) {
      const code = errorCodeOf(error);
      if (error instanceof client.AuthorizationResponseError && code) {
        return { ok: false, error: ANSWERED_ERRORS[code] ?? 'failed', detail: code };
      }
      if (isTransportError(error)) {
        console.warn(`[auth] OIDC sign-in: ${pending.issuer} could not be reached: ${describe(error)}`);
        return { ok: false, error: 'issuer_unreachable' };
      }
      if (error instanceof client.ResponseBodyError) {
        console.warn(`[auth] OIDC sign-in: the token endpoint of ${pending.issuer} answered ${code ?? 'an error'}`);
        return { ok: false, error: 'failed', detail: code };
      }
      console.warn(`[auth] OIDC sign-in: the token response from ${pending.issuer} was refused: ${describe(error)}`);
      return { ok: false, error: 'invalid_token' };
    }

    if (!claims) return { ok: false, error: 'invalid_token' };
    const webId = claims.webid;
    if (typeof webId !== 'string' || !webId) return { ok: false, error: 'missing_claim', detail: 'webid' };
    const authTime = claims.auth_time;
    if (typeof authTime !== 'number' || !Number.isFinite(authTime)) {
      return { ok: false, error: 'missing_claim', detail: 'auth_time' };
    }
    const email = typeof claims.email === 'string' && claims.email ? claims.email : undefined;
    if (options.requireEmail && !email) return { ok: false, error: 'missing_claim', detail: 'email' };
    const issuer = claims.iss as string;

    const refused = await checkIssuer(webId, issuer);
    if (refused) {
      console.warn(`[auth] OIDC sign-in: issuer check failed for ${issuer}: ${refused}`);
      return { ok: false, error: 'issuer_refused' };
    }

    return {
      ok: true,
      identity: {
        webId,
        issuer,
        subject: claims.sub as string,
        authTime,
        ...(email ? { email } : {}),
        ...(typeof claims.email_verified === 'boolean' ? { emailVerified: claims.email_verified } : {}),
      },
    };
  };

  return { begin, complete, clearCache: () => configurations.clear() };
};
