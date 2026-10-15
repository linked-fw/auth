/**
 * A `fetch` that never connects to a private address, for requests to hosts named by user input:
 * WebID profiles, WebFinger, and a Solid-OIDC issuer's discovery, JWKS and token endpoints.
 *
 * `isFetchableUrl` refuses private IP literals, but a public host name can resolve to a private
 * address, or resolve to a public one when checked and a private one when connected (DNS
 * rebinding). Here the check happens where the connection is made: the agent's `lookup` resolves
 * the name, refuses it when any address it resolves to is blocked (`isBlockedAddress`), and
 * connects to the addresses it checked. Server-only.
 */
import dns from 'node:dns';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { isBlockedAddress, isFetchableUrl } from './issuerDiscovery.js';

/** Resolves a host name to every address it has, as `dns.promises.lookup` with `all: true`. */
export type ResolveHost = (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;

export interface GuardedFetchOptions {
  /** Allow loopback addresses (`127.0.0.0/8`, `::1`), for development. Default `false`. */
  allowLocalhost?: boolean;
  /** Replaces the system resolver (tests). */
  resolve?: ResolveHost;
}

/** The error a refused connection fails with; `fetch` rejects with it as its `cause`. */
export class BlockedAddressError extends Error {
  readonly code = 'ERR_BLOCKED_ADDRESS';
  constructor(hostname: string) {
    super(`Refused to connect to ${hostname}: it resolves to a private or loopback address`);
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number
) => void;

const systemResolve: ResolveHost = (hostname, options) => dns.promises.lookup(hostname, options);

/**
 * A `lookup` for `net.connect`/`tls.connect` that refuses a host when any of its addresses is
 * blocked. It answers in the form the caller asked for: every address with `all` (Node asks for
 * that when it tries several addresses), else the first.
 */
export const guardedLookup =
  (allowLocalhost: boolean, resolve: ResolveHost = systemResolve) =>
  (hostname: string, options: LookupOneOptions | LookupAllOptions, callback: LookupCallback): void => {
    resolve(hostname, { family: options?.family, hints: options?.hints, all: true }).then(
      (addresses) => {
        if (!addresses.length) {
          const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          error.code = 'ENOTFOUND';
          callback(error);
          return;
        }
        if (addresses.some(({ address }) => isBlockedAddress(address, allowLocalhost))) {
          callback(new BlockedAddressError(hostname));
          return;
        }
        if (options?.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      },
      (error) => callback(error)
    );
  };

/** The error a URL refused before any connection fails with (scheme, credentials, IP literal). */
export class RefusedUrlError extends Error {
  readonly code = 'ERR_REFUSED_URL';
  constructor(href: string) {
    super(`Refused to fetch ${href}: only https: to a public host (http: and loopback in development)`);
    this.name = 'RefusedUrlError';
  }
}

type FetchInput = Parameters<typeof undiciFetch>[0];

const hrefOf = (input: FetchInput): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url;

/**
 * A `fetch` (undici's, with its own agent) that checks every URL with `isFetchableUrl` and connects
 * only through `guardedLookup`. The URL check covers IP literals, which skip `lookup`; the lookup
 * covers host names. It never follows a redirect (a hop to an IP literal would skip both checks):
 * `redirect: 'follow'` is turned into `'manual'`, and callers that follow redirects fetch each hop
 * themselves, as issuer discovery does.
 */
export const createGuardedFetch = (options: GuardedFetchOptions = {}): typeof fetch => {
  const allowLocalhost = options.allowLocalhost ?? false;
  const dispatcher = new Agent({
    connect: { lookup: guardedLookup(allowLocalhost, options.resolve) },
  });
  const guarded = async (input: FetchInput, init?: Parameters<typeof undiciFetch>[1]) => {
    const href = hrefOf(input);
    if (!isFetchableUrl(href, allowLocalhost)) {
      throw new RefusedUrlError(href);
    }
    const redirect = init?.redirect === 'error' ? 'error' : 'manual';
    return undiciFetch(input, { ...init, redirect, dispatcher });
  };
  // undici's fetch is the implementation behind Node's; only its type declarations differ.
  return guarded as unknown as typeof fetch;
};
