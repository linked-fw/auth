/**
 * The issuer's access token of a Solid-OIDC sign-in, kept server-side per session, and the hook
 * that sends it to data servers on the user's behalf.
 *
 * A sign-in through an issuer that gives a DPoP-bound JWT access token (`IssuerGrant`, see
 * `oidcSignin.ts`) keeps that token and its DPoP key under the app's session id (`sid`), sealed
 * with a key derived from the JWT secret: a store, the default one in memory or the app's own
 * (`setIssuerTokenStore`), only ever holds sealed records. Neither the token nor the key goes into
 * a cookie or a log. The record goes when the session does (sign-out, revocation, account
 * removal) and once the token expires; there is no refresh, so after that the user's queries go
 * without it.
 *
 * The hook (`USER_TOKEN_HEADERS_HOOK` on `globalThis`, installed by the backend provider at start)
 * answers, for the request a query is made in and the data server's method and URL, the headers
 * `x-linked-user-token` (the access token) and `DPoP` (a fresh proof for that method and URL,
 * RFC 9449). `@_linked/server`'s `RemoteDataset` calls it for every request it sends. It answers
 * `undefined` for a request without a session, a session without a kept token (password, email
 * code, Google, Apple, guest and dev sign-ins) and a token that expires within 30 seconds.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';
import { sharedState } from '@_linked/core/utils/sharedState';
import type { IssuerGrant } from './oidcSignin.js';
import { getJwtSecret } from './secrets.js';

/** The `globalThis` key of the hook `RemoteDataset` calls. */
export const USER_TOKEN_HEADERS_HOOK = Symbol.for('@_linked/auth:userTokenHeaders');
/** The header the user's access token travels in; the proof goes in `DPoP`. */
export const USER_TOKEN_HEADER = 'x-linked-user-token';
/** A token that expires sooner than this is no longer sent: the request could outlive it. */
export const USER_TOKEN_MIN_REMAINING_MS = 30_000;

/** The headers the hook answers. */
export interface UserTokenHeaders {
  'x-linked-user-token': string;
  DPoP: string;
}

/** The hook's signature: the request a query is made in, and where it goes. */
export type UserTokenHeadersHook = (
  request: unknown,
  target: { method: string; url: string }
) => Promise<UserTokenHeaders | undefined>;

/** A kept grant as a store holds it: sealed, with its expiry in the clear for cleanup. */
export interface SealedIssuerGrant {
  sealed: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** Where kept grants live, by session id. The default keeps them in this process's memory. */
export interface IssuerTokenStore {
  put(sessionId: string, record: SealedIssuerGrant): Promise<void>;
  get(sessionId: string): Promise<SealedIssuerGrant | undefined>;
  remove(sessionId: string): Promise<void>;
  /** Remove the records expired before `now` (ms); returns how many. */
  removeExpired(now: number): Promise<number>;
}

/** Keeps grants in memory: lost on restart, after which the user's queries go without a token. */
export class MemoryIssuerTokenStore implements IssuerTokenStore {
  readonly records = new Map<string, SealedIssuerGrant>();

  async put(sessionId: string, record: SealedIssuerGrant) {
    this.records.set(sessionId, { ...record });
  }
  async get(sessionId: string) {
    const record = this.records.get(sessionId);
    return record ? { ...record } : undefined;
  }
  async remove(sessionId: string) {
    this.records.delete(sessionId);
  }
  async removeExpired(now: number) {
    let removed = 0;
    for (const [sessionId, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(sessionId);
        removed++;
      }
    }
    return removed;
  }
}

const state = sharedState('@_linked/auth', 'issuerTokens', () => ({
  store: new MemoryIssuerTokenStore() as IssuerTokenStore,
}));

/** Replace where kept grants live (default: memory). */
export function setIssuerTokenStore(store: IssuerTokenStore) {
  state.store = store;
}
export function getIssuerTokenStore(): IssuerTokenStore {
  return state.store;
}

// ---------------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------------

const VERSION = 'v1';
const KEY_LABEL = '@_linked/auth issuer grant v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyFor = (secret: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), KEY_LABEL, 32));

/** The grant as an opaque string, bound to `sessionId` (a record moved to another session fails). */
export function sealIssuerGrant(grant: IssuerGrant, sessionId: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  cipher.setAAD(Buffer.from(`${VERSION}:${sessionId}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(grant), 'utf8'), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

/** The grant `sealed` holds for `sessionId`, or `undefined` when it is not one sealed for it. */
export function openIssuerGrant(sealed: unknown, sessionId: string, secret: string): IssuerGrant | undefined {
  if (typeof sealed !== 'string') return undefined;
  const [version, data, ...rest] = sealed.split('.');
  if (version !== VERSION || !data || rest.length) return undefined;
  try {
    const raw = Buffer.from(data, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(`${VERSION}:${sessionId}`));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const body = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    const grant = JSON.parse(body.toString('utf8')) as IssuerGrant;
    if (
      typeof grant?.accessToken !== 'string' ||
      typeof grant.expiresAt !== 'number' ||
      !grant.dpopPrivateJwk ||
      !grant.dpopPublicJwk
    ) {
      return undefined;
    }
    return grant;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Keeping, reading, dropping
// ---------------------------------------------------------------------------------------------

/** Keep `grant` for the session `sessionId` (after an OIDC sign-in). */
export async function keepIssuerGrant(sessionId: string, grant: IssuerGrant): Promise<void> {
  if (!sessionId) return;
  await state.store.put(sessionId, {
    sealed: sealIssuerGrant(grant, sessionId, getJwtSecret()),
    expiresAt: grant.expiresAt,
  });
}

/** The session's grant while it has not expired; an expired one is removed. */
export async function issuerGrantOf(sessionId: string, now: number = Date.now()): Promise<IssuerGrant | undefined> {
  if (!sessionId) return undefined;
  const record = await state.store.get(sessionId);
  if (!record) return undefined;
  if (record.expiresAt <= now) {
    await state.store.remove(sessionId);
    return undefined;
  }
  return openIssuerGrant(record.sealed, sessionId, getJwtSecret());
}

/** Drop the grants of these sessions (sign-out, revocation, account removal). Never throws. */
export async function dropIssuerGrants(sessionIds: Iterable<string | undefined>): Promise<void> {
  for (const sessionId of new Set(sessionIds)) {
    if (!sessionId) continue;
    try {
      await state.store.remove(sessionId);
    } catch (err) {
      console.warn('@_linked/auth: could not drop an issuer token', (err as Error)?.message ?? err);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------------

/** `url` as a DPoP proof's `htu`: without query and fragment (RFC 9449 §4.2). */
export const htuOf = (url: string): string => {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
};

/** base64url(sha256(accessToken)): a proof's `ath`. */
export const accessTokenHash = (accessToken: string): string =>
  createHash('sha256').update(accessToken, 'ascii').digest('base64url');

/** A DPoP proof for `method` and `url` with the grant's key, bound to its access token. */
export async function dpopProofFor(
  grant: IssuerGrant,
  target: { method: string; url: string },
  now: number = Date.now()
): Promise<string> {
  const { kty, crv, x, y, n, e } = grant.dpopPublicJwk as Record<string, string | undefined>;
  const publicJwk = Object.fromEntries(Object.entries({ kty, crv, x, y, n, e }).filter(([, v]) => v !== undefined));
  const alg = kty === 'EC' ? 'ES256' : 'RS256';
  const key = await importJWK(grant.dpopPrivateJwk as Parameters<typeof importJWK>[0], alg);
  return new SignJWT({
    htm: target.method.toUpperCase(),
    htu: htuOf(target.url),
    jti: randomUUID(),
    ath: accessTokenHash(grant.accessToken),
  })
    .setProtectedHeader({ typ: 'dpop+jwt', alg, jwk: publicJwk })
    .setIssuedAt(Math.floor(now / 1000))
    .sign(key);
}

/** The session id of a request the auth middleware read (`request.linkedAuth.sid`). */
const sessionIdOf = (request: unknown): string | undefined => {
  const sid = (request as { linkedAuth?: { sid?: unknown } } | null | undefined)?.linkedAuth?.sid;
  return typeof sid === 'string' && sid ? sid : undefined;
};

/** The hook: the request's user's token and a fresh proof, or `undefined`. Never throws. */
export const userTokenHeaders: UserTokenHeadersHook = async (request, target) => {
  const sessionId = sessionIdOf(request);
  if (!sessionId) return undefined;
  try {
    const now = Date.now();
    const grant = await issuerGrantOf(sessionId, now);
    if (!grant || grant.expiresAt - now < USER_TOKEN_MIN_REMAINING_MS) return undefined;
    return { [USER_TOKEN_HEADER]: grant.accessToken, DPoP: await dpopProofFor(grant, target, now) } as UserTokenHeaders;
  } catch (err) {
    console.warn('@_linked/auth: could not make the user token headers', (err as Error)?.message ?? err);
    return undefined;
  }
};

/** Install {@link userTokenHeaders} as the hook (the backend provider does, at start). */
export function installUserTokenHeaders(): void {
  (globalThis as unknown as Record<symbol, unknown>)[USER_TOKEN_HEADERS_HOOK] = userTokenHeaders;
}
