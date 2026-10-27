/**
 * The verifier a data server uses for a user's Solid-OIDC access token and its DPoP proof (what
 * `issuerTokens.ts`' hook sends as `x-linked-user-token` and `DPoP`).
 *
 * The token: a JWT (`typ` `at+jwt`) signed with a key of its issuer's JWKS (the `jwks_uri` of the issuer's
 * discovery document, whose `issuer` must be the token's `iss`), `aud` containing `solid`, `exp`
 * ahead, a `webid` whose profile names `iss` as a `solid:oidcIssuer`, `client_id` the one the data
 * server expects, and `cnf.jkt`. The proof (RFC 9449): `typ` `dpop+jwt`, signed with the public
 * key in its header, whose thumbprint is `cnf.jkt`; `htm` and `htu` the request's method and URL
 * (without query and fragment), `iat` within 60 seconds, `ath` the token's hash, and a `jti` not
 * seen while a proof with that `iat` could still be accepted.
 *
 * A verified token is kept by its hash until its `exp`, at most 5 minutes, so a steady stream of
 * queries costs no fetch; the proof and the client are checked on every call. An issuer whose keys,
 * or a WebID whose profile, could not be read is not asked again for 30 seconds; concurrent
 * requests for one issuer's keys share one fetch, an unknown `kid` refetches them once the last
 * fetch is 5 seconds old, and one requester (`VerifySolidAccessTokenInput.requester`) makes the
 * verifier fetch at most 5 issuers it has not seen per minute. Issuers and
 * profiles are fetched through the guarded fetch (`guardedFetch.ts`); loopback and `http:` only
 * with `allowLocalhost`.
 *
 * Failures are typed: {@link InvalidUserTokenError} (with a reason; `wrong-client` when only the
 * client differs), {@link IssuerUnavailableError} (the issuer's keys or the WebID's profile could
 * not be read, or the requester asked for too many new issuers, so nothing can be said) and
 * {@link ProofCacheFullError} (the `jti` memory is full of proofs still in their window: a proof
 * is refused rather than a live `jti` forgotten).
 */
import { createHash } from 'node:crypto';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  importJWK,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
} from 'jose';
import { sharedState } from '@_linked/core/utils/sharedState';
import { createGuardedFetch } from './guardedFetch.js';
import { fetchOidcIssuers, isFetchableUrl } from './issuerDiscovery.js';
import { sameIssuer } from './oidcSignin.js';

export type InvalidUserTokenReason =
  /** Not a JWT, or a claim is missing or of the wrong type. */
  | 'malformed'
  /** The signature does not verify with the issuer's keys. */
  | 'signature'
  | 'expired'
  /** `aud` does not contain `solid`. */
  | 'audience'
  /** `iss` is not one this server fetches, or the WebID's profile does not name it. */
  | 'issuer'
  /** `client_id` is not the expected client. */
  | 'wrong-client'
  /** The DPoP proof is missing, malformed, badly signed, or for another method, URL or time. */
  | 'proof'
  /** The proof's key is not the one the token is bound to (`cnf.jkt`), or `ath` differs. */
  | 'binding'
  /** The proof's `jti` was seen before. */
  | 'replay';

export class InvalidUserTokenError extends Error {
  readonly code = 'invalid-user-token';
  constructor(
    readonly reason: InvalidUserTokenReason,
    message: string
  ) {
    super(message);
    this.name = 'InvalidUserTokenError';
  }
}

export class IssuerUnavailableError extends Error {
  readonly code = 'issuer-unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'IssuerUnavailableError';
  }
}

/** The `jti` memory holds only proofs still in their window and is full: try again. */
export class ProofCacheFullError extends Error {
  readonly code = 'proof-cache-full';
  constructor(message: string) {
    super(message);
    this.name = 'ProofCacheFullError';
  }
}

export interface VerifySolidAccessTokenInput {
  accessToken: string;
  /** The `DPoP` header. */
  dpop: string | undefined;
  /** The request's method. */
  method: string;
  /** The URL the client called (the data server's public URL, never one built from `Host`). */
  url: string;
  /** The `client_id` the token must have been issued to. */
  expectedClientId: string;
  /** Fetch `http:` and loopback issuers and WebIDs. Default: the verifier's setting. */
  allowLocalhost?: boolean;
  /**
   * Who sent the token (for a data server, the credential the request came with): it may make the
   * verifier fetch at most `newIssuersPerMinute` issuers it has not seen per minute.
   */
  requester?: string;
}

export interface VerifiedSolidAccessToken {
  webId: string;
  issuer: string;
  clientId: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export interface SolidAccessTokenVerifierOptions {
  /** Fetch `http:` and loopback issuers and WebIDs. Default `false`. */
  allowLocalhost?: boolean;
  /** Deadline for each fetch, in ms. Default 5000. */
  timeoutMs?: number;
  /** How long a verified token is kept, at most (it is never kept past its `exp`). Default 5 minutes. */
  tokenCacheTtlMs?: number;
  /** How long an issuer's keys are reused. Default 10 minutes. */
  jwksTtlMs?: number;
  /** How long a WebID's issuers are reused. Default 5 minutes. */
  profileTtlMs?: number;
  /** Most entries per cache; the oldest goes first. Default 1000 (proof `jti`s: 10 000, never live ones). */
  maxEntries?: number;
  /** Issuers not seen before one requester may make the verifier fetch per minute. Default 5. */
  newIssuersPerMinute?: number;
  /** Replaces the guarded fetch (tests). */
  fetch?: typeof fetch;
  /** Clock in ms. Default `Date.now`. */
  now?: () => number;
}

export interface SolidAccessTokenVerifier {
  verify(input: VerifySolidAccessTokenInput): Promise<VerifiedSolidAccessToken>;
  /** Forget every cached token, key set, profile and `jti`. */
  clear(): void;
}

/** How far a proof's `iat` may be from now, in seconds. */
export const DPOP_IAT_WINDOW_S = 60;
/** An unknown `kid` refetches the issuer's keys at most this often. */
const JWKS_REFETCH_MIN_MS = 5_000;
/** How long an issuer whose keys or a profile that could not be read is not asked again. */
const UNAVAILABLE_TTL_MS = 30_000;
const PROOF_ALGORITHMS = ['ES256', 'ES384', 'ES512', 'RS256', 'PS256', 'EdDSA'];
const TOKEN_ALGORITHMS = ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'PS256', 'EdDSA'];

/** A bounded map whose entries expire. */
class ExpiringMap<V> {
  private readonly entries = new Map<string, { value: V; until: number }>();
  constructor(private readonly maxEntries: number) {}
  get(key: string, now: number): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: V, until: number) {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(key, { value, until });
  }
  /**
   * Like `set`, but only expired entries make room: when every entry is still live, nothing is
   * dropped and the answer is `false`.
   */
  setKeepingLive(key: string, value: V, until: number, now: number): boolean {
    if (this.entries.size >= this.maxEntries) {
      for (const [k, entry] of this.entries) if (entry.until <= now) this.entries.delete(k);
    }
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) return false;
    this.entries.set(key, { value, until });
    return true;
  }
  clear() {
    this.entries.clear();
  }
}

interface VerifiedToken extends VerifiedSolidAccessToken {
  jkt: string;
}

interface IssuerKeys {
  keys: ReturnType<typeof createLocalJWKSet>;
  fetchedAt: number;
}

const tokenHash = (token: string) => createHash('sha256').update(token, 'ascii').digest('hex');
const athOf = (token: string) => createHash('sha256').update(token, 'ascii').digest('base64url');

/** `url` without query and fragment, as a proof's `htu` is compared. */
const normalizeHtu = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
};

const invalid = (reason: InvalidUserTokenReason, message: string) => new InvalidUserTokenError(reason, message);

export function createSolidAccessTokenVerifier(
  options: SolidAccessTokenVerifierOptions = {}
): SolidAccessTokenVerifier {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5000;
  const tokenCacheTtlMs = options.tokenCacheTtlMs ?? 5 * 60_000;
  const jwksTtlMs = options.jwksTtlMs ?? 10 * 60_000;
  const profileTtlMs = options.profileTtlMs ?? 5 * 60_000;
  const maxEntries = options.maxEntries ?? 1000;
  const newIssuersPerMinute = options.newIssuersPerMinute ?? 5;
  const fetches = new Map<boolean, typeof fetch>();
  const fetchFor = (allowLocalhost: boolean): typeof fetch => {
    if (options.fetch) return options.fetch;
    let f = fetches.get(allowLocalhost);
    if (!f) {
      f = createGuardedFetch({ allowLocalhost, responseTimeoutMs: timeoutMs, maxResponseBytes: 256 * 1024 });
      fetches.set(allowLocalhost, f);
    }
    return f;
  };

  const tokens = new ExpiringMap<VerifiedToken>(maxEntries);
  const issuerKeys = new ExpiringMap<IssuerKeys>(maxEntries);
  const profiles = new ExpiringMap<string[]>(maxEntries);
  const seenJtis = new ExpiringMap<true>(maxEntries * 10);
  /** The fetch of each issuer's keys under way, shared by concurrent requests. */
  const keysInFlight = new Map<string, Promise<IssuerKeys>>();
  /** Per requester, when it last made the verifier fetch an issuer it had not seen. */
  const newIssuerFetches = new ExpiringMap<number[]>(maxEntries);
  const countNewIssuer = (requester: string, issuer: string) => {
    const since = now() - 60_000;
    const recent = (newIssuerFetches.get(requester, now()) ?? []).filter((at) => at > since);
    if (recent.length >= newIssuersPerMinute) {
      throw new IssuerUnavailableError(`${requester} asked for too many new issuers this minute (${issuer} refused)`);
    }
    recent.push(now());
    newIssuerFetches.set(requester, recent, now() + 60_000);
  };
  /** Issuers and WebIDs that could not be read, so a stream of requests does not refetch them. */
  const unavailable = new ExpiringMap<string>(maxEntries);
  const remembered = async <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const failed = unavailable.get(key, now());
    if (failed) throw new IssuerUnavailableError(failed);
    try {
      return await read();
    } catch (err) {
      if (err instanceof IssuerUnavailableError) unavailable.set(key, err.message, now() + UNAVAILABLE_TTL_MS);
      throw err;
    }
  };

  const fetchJson = async (url: string, allowLocalhost: boolean): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchFor(allowLocalhost)(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new IssuerUnavailableError(`${url} could not be fetched: ${(err as Error)?.message ?? err}`);
    }
    if (!response.ok) throw new IssuerUnavailableError(`${url} answered ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new IssuerUnavailableError(`${url} did not answer JSON`);
    }
  };

  const loadKeys = (issuer: string, allowLocalhost: boolean): Promise<IssuerKeys> => {
    let pending = keysInFlight.get(issuer);
    if (!pending) {
      pending = remembered(`issuer ${issuer}`, () => fetchKeys(issuer, allowLocalhost)).finally(() =>
        keysInFlight.delete(issuer)
      );
      keysInFlight.set(issuer, pending);
    }
    return pending;
  };

  const fetchKeys = async (issuer: string, allowLocalhost: boolean): Promise<IssuerKeys> => {
    const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const metadata = (await fetchJson(discoveryUrl, allowLocalhost)) as { issuer?: unknown; jwks_uri?: unknown };
    if (typeof metadata?.issuer !== 'string' || !sameIssuer(metadata.issuer, issuer)) {
      throw new IssuerUnavailableError(`the discovery document of ${issuer} names another issuer`);
    }
    const jwksUri = metadata.jwks_uri;
    if (typeof jwksUri !== 'string' || !isFetchableUrl(jwksUri, allowLocalhost)) {
      throw new IssuerUnavailableError(`the discovery document of ${issuer} has no usable jwks_uri`);
    }
    const jwks = (await fetchJson(jwksUri, allowLocalhost)) as JSONWebKeySet;
    if (!jwks || !Array.isArray(jwks.keys)) throw new IssuerUnavailableError(`${jwksUri} is not a JWK set`);
    const loaded = { keys: createLocalJWKSet({ keys: jwks.keys.filter((k) => k && !('d' in k)) }), fetchedAt: now() };
    issuerKeys.set(issuer, loaded, now() + jwksTtlMs);
    return loaded;
  };

  const issuersOf = async (webId: string, allowLocalhost: boolean): Promise<string[]> => {
    const cached = profiles.get(webId, now());
    if (cached) return cached;
    const profile = await remembered(`profile ${webId}`, async () => {
      const read = await fetchOidcIssuers(webId, { allowLocalhost, timeoutMs, fetch: fetchFor(allowLocalhost) });
      if (read.ok === false && read.reason === 'unreachable') {
        throw new IssuerUnavailableError(`the profile of ${webId} could not be read`);
      }
      return read;
    });
    if (profile.ok === false) throw invalid('issuer', `the WebID ${webId} is not one this server reads`);
    profiles.set(webId, profile.issuers, now() + profileTtlMs);
    return profile.issuers;
  };

  const verifyToken = async (accessToken: string, allowLocalhost: boolean, requester: string): Promise<VerifiedToken> => {
    const hash = tokenHash(accessToken);
    const cached = tokens.get(hash, now());
    if (cached) return cached;

    let unverified: ReturnType<typeof decodeJwt>;
    try {
      decodeProtectedHeader(accessToken);
      unverified = decodeJwt(accessToken);
    } catch {
      throw invalid('malformed', 'the access token is not a JWT');
    }
    const issuer = unverified.iss;
    if (typeof issuer !== 'string' || !isFetchableUrl(issuer, allowLocalhost)) {
      throw invalid('issuer', `the token's issuer is not one this server fetches: ${String(issuer)}`);
    }

    let keys = issuerKeys.get(issuer, now());
    if (!keys) {
      if (!keysInFlight.has(issuer) && !unavailable.get(`issuer ${issuer}`, now())) countNewIssuer(requester, issuer);
      keys = await loadKeys(issuer, allowLocalhost);
    }
    const check = (set: IssuerKeys) =>
      jwtVerify(accessToken, set.keys, {
        issuer: [issuer],
        audience: 'solid',
        typ: 'at+jwt',
        algorithms: TOKEN_ALGORITHMS,
        currentDate: new Date(now()),
        requiredClaims: ['exp', 'webid', 'client_id'],
      });
    let payload: Awaited<ReturnType<typeof check>>['payload'];
    try {
      try {
        ({ payload } = await check(keys));
      } catch (err) {
        // a key the cached set lacks: the issuer may have rotated
        if (err instanceof joseErrors.JWKSNoMatchingKey && now() - keys.fetchedAt >= JWKS_REFETCH_MIN_MS) {
          keys = await loadKeys(issuer, allowLocalhost);
          ({ payload } = await check(keys));
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof IssuerUnavailableError) throw err;
      if (err instanceof joseErrors.JWTExpired) throw invalid('expired', 'the access token has expired');
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        if (err.claim === 'aud') throw invalid('audience', 'the access token is not for solid');
        if (err.claim === 'typ') throw invalid('malformed', 'the access token is not an at+jwt');
        throw invalid('malformed', `the access token's ${err.claim} claim is not valid`);
      }
      throw invalid('signature', `the access token does not verify with the keys of ${issuer}`);
    }

    const { webid: webId, client_id: clientId, exp } = payload as { webid?: unknown; client_id?: unknown; exp?: unknown };
    const jkt = (payload.cnf as { jkt?: unknown } | undefined)?.jkt;
    if (typeof webId !== 'string' || typeof clientId !== 'string' || typeof exp !== 'number' || typeof jkt !== 'string') {
      throw invalid('malformed', 'the access token lacks webid, client_id, exp or cnf.jkt');
    }
    const issuers = await issuersOf(webId, allowLocalhost);
    if (!issuers.some((listed) => sameIssuer(listed, issuer))) {
      throw invalid('issuer', `the profile of ${webId} does not name ${issuer}`);
    }
    const verified: VerifiedToken = { webId, issuer, clientId, expiresAt: exp * 1000, jkt };
    tokens.set(hash, verified, Math.min(exp * 1000, now() + tokenCacheTtlMs));
    return verified;
  };

  const verifyProof = async (input: VerifySolidAccessTokenInput, token: VerifiedToken): Promise<void> => {
    const proof = input.dpop;
    if (typeof proof !== 'string' || !proof) throw invalid('proof', 'the DPoP proof is missing');
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(proof);
    } catch {
      throw invalid('proof', 'the DPoP proof is not a JWT');
    }
    const jwk = header.jwk as JWK | undefined;
    if (header.typ !== 'dpop+jwt' || typeof header.alg !== 'string' || !PROOF_ALGORITHMS.includes(header.alg)) {
      throw invalid('proof', 'the DPoP proof is not a dpop+jwt with an asymmetric algorithm');
    }
    if (!jwk || typeof jwk !== 'object' || 'd' in jwk) throw invalid('proof', 'the DPoP proof has no public jwk');
    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
    try {
      const key = await importJWK(jwk, header.alg);
      ({ payload } = await jwtVerify(proof, key, { typ: 'dpop+jwt', algorithms: [header.alg], currentDate: new Date(now()) }));
    } catch {
      throw invalid('proof', 'the DPoP proof does not verify with its own key');
    }
    if ((await calculateJwkThumbprint(jwk)) !== token.jkt) {
      throw invalid('binding', "the DPoP proof's key is not the one the token is bound to");
    }
    const { htm, htu, iat, jti, ath } = payload as Record<string, unknown>;
    if (htm !== input.method.toUpperCase()) throw invalid('proof', `the DPoP proof is for ${String(htm)}, not ${input.method}`);
    const expected = normalizeHtu(input.url);
    if (typeof htu !== 'string' || !expected || normalizeHtu(htu) !== expected) {
      throw invalid('proof', `the DPoP proof is for ${String(htu)}, not ${expected}`);
    }
    if (typeof iat !== 'number' || Math.abs(now() / 1000 - iat) > DPOP_IAT_WINDOW_S) {
      throw invalid('proof', 'the DPoP proof was not made now');
    }
    if (ath !== athOf(input.accessToken)) throw invalid('binding', 'the DPoP proof is for another access token');
    if (typeof jti !== 'string' || !jti || jti.length > 256) throw invalid('proof', 'the DPoP proof has no jti');
    const jtiKey = `${token.jkt}:${jti}`;
    if (seenJtis.get(jtiKey, now())) throw invalid('replay', 'the DPoP proof was used before');
    // Remembered while a proof with this `iat` could still be accepted; after that the `iat`
    // check refuses a replay.
    if (!seenJtis.setKeepingLive(jtiKey, true, (iat + DPOP_IAT_WINDOW_S) * 1000 + 1000, now())) {
      throw new ProofCacheFullError('too many recent DPoP proofs to remember another; try again');
    }
  };

  return {
    async verify(input) {
      if (typeof input?.accessToken !== 'string' || !input.accessToken) {
        throw invalid('malformed', 'no access token');
      }
      const allowLocalhost = input.allowLocalhost ?? options.allowLocalhost ?? false;
      const token = await verifyToken(input.accessToken, allowLocalhost, input.requester ?? '');
      if (token.expiresAt <= now()) throw invalid('expired', 'the access token has expired');
      if (token.clientId !== input.expectedClientId) {
        throw invalid('wrong-client', `the access token was issued to ${token.clientId}, not ${input.expectedClientId}`);
      }
      await verifyProof(input, token);
      return { webId: token.webId, issuer: token.issuer, clientId: token.clientId, expiresAt: token.expiresAt };
    },
    clear() {
      tokens.clear();
      issuerKeys.clear();
      unavailable.clear();
      newIssuerFetches.clear();
      profiles.clear();
      seenJtis.clear();
    },
  };
}

/** The process's verifier, shared by every copy of this module. */
const shared = sharedState('@_linked/auth', 'solidAccessTokenVerifier', () => ({
  verifier: undefined as SolidAccessTokenVerifier | undefined,
}));

/**
 * Verify a user's access token and its DPoP proof with the process's verifier (its caches and
 * `jti` memory are shared by every call). Throws {@link InvalidUserTokenError} or
 * {@link IssuerUnavailableError}.
 */
export function verifySolidAccessToken(input: VerifySolidAccessTokenInput): Promise<VerifiedSolidAccessToken> {
  shared.verifier ??= createSolidAccessTokenVerifier();
  return shared.verifier.verify(input);
}
