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
import { Agent, Response as UndiciResponse, fetch as undiciFetch } from 'undici';
import { isBlockedAddress, isFetchableUrl } from './issuerDiscovery.js';

/** Resolves a host name to every address it has, as `dns.promises.lookup` with `all: true`. */
export type ResolveHost = (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;

export interface GuardedFetchOptions {
  /** Allow loopback addresses (`127.0.0.0/8`, `::1`), for development. Default `false`. */
  allowLocalhost?: boolean;
  /** Replaces the system resolver (tests). */
  resolve?: ResolveHost;
  /** Largest response body read; a larger one fails the read. Default 1 MB. */
  maxResponseBytes?: number;
  /** Deadline for a whole response, from the request to the body's last byte. Default 10 s. */
  responseTimeoutMs?: number;
}

/** The error a body read fails with when the body is larger than `maxResponseBytes`. */
export class ResponseTooLargeError extends Error {
  readonly code = 'ERR_RESPONSE_TOO_LARGE';
  constructor(href: string, maxBytes: number) {
    super(`The response from ${href} is larger than ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** The error a body read fails with when the response takes longer than `responseTimeoutMs`. */
export class ResponseTimeoutError extends Error {
  readonly code = 'ERR_RESPONSE_TIMEOUT';
  constructor(href: string, timeoutMs: number) {
    super(`The response from ${href} took longer than ${timeoutMs} ms`);
    this.name = 'ResponseTimeoutError';
  }
}

// statuses whose response may not have a body
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * `response` with its body capped at `maxBytes` and finished by `deadline` (ms since the epoch):
 * a body that grows past the cap, or is still arriving at the deadline, errors its reader and
 * cancels the connection. Callers that buffer the whole body (openid-client's `response.json()`)
 * then fail instead of reading without bound.
 */
const limitResponse = (
  response: UndiciResponse,
  href: string,
  maxBytes: number,
  deadline: number,
  timeoutMs: number
): UndiciResponse => {
  const source = response.body;
  if (!source || NULL_BODY_STATUSES.has(response.status)) return response;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void source.cancel().catch(() => {});
    throw new ResponseTooLargeError(href, maxBytes);
  }
  const reader = source.getReader();
  let received = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limited = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        controller.error(new ResponseTimeoutError(href, timeoutMs));
        void reader.cancel().catch(() => {});
      }, Math.max(0, deadline - Date.now()));
      timer.unref?.();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          controller.close();
          return;
        }
        received += value.byteLength;
        if (received > maxBytes) {
          clearTimeout(timer);
          controller.error(new ResponseTooLargeError(href, maxBytes));
          void reader.cancel().catch(() => {});
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        clearTimeout(timer);
        controller.error(error);
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
  // undici accepts a ReadableStream body; its `BodyInit` type does not include one
  const wrapped = new UndiciResponse(
    limited as unknown as ConstructorParameters<typeof UndiciResponse>[0],
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }
  );
  // a constructed response has no URL; keep the one it was fetched from
  Object.defineProperty(wrapped, 'url', { value: response.url });
  return wrapped;
};

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

// Node implements `AbortSignal.any`. The DOM `AbortSignal` in this compile does not declare it.
const anyAbortSignal = (signals: AbortSignal[]): AbortSignal =>
  (AbortSignal as unknown as { any(signals: AbortSignal[]): AbortSignal }).any(signals);

const hrefOf = (input: FetchInput): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url;

/**
 * A `fetch` (undici's, with its own agent) that checks every URL with `isFetchableUrl` and connects
 * only through `guardedLookup`. The URL check covers IP literals, which skip `lookup`; the lookup
 * covers host names. It never follows a redirect (a hop to an IP literal would skip both checks):
 * `redirect: 'follow'` is turned into `'manual'`, and callers that follow redirects fetch each hop
 * themselves, as issuer discovery does. Every response is bounded: its body may not exceed
 * `maxResponseBytes`, and the whole response must arrive within `responseTimeoutMs`.
 */
export const createGuardedFetch = (options: GuardedFetchOptions = {}): typeof fetch => {
  const allowLocalhost = options.allowLocalhost ?? false;
  const maxBytes = options.maxResponseBytes ?? 1024 * 1024;
  const timeoutMs = options.responseTimeoutMs ?? 10_000;
  const dispatcher = new Agent({
    connect: { lookup: guardedLookup(allowLocalhost, options.resolve) },
  });
  const guarded = async (input: FetchInput, init?: Parameters<typeof undiciFetch>[1]) => {
    const href = hrefOf(input);
    if (!isFetchableUrl(href, allowLocalhost)) {
      throw new RefusedUrlError(href);
    }
    const redirect = init?.redirect === 'error' ? 'error' : 'manual';
    const deadline = Date.now() + timeoutMs;
    // the deadline covers the headers as well; the caller's own signal still applies
    const signal = init?.signal
      ? anyAbortSignal([init.signal as AbortSignal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const response = await undiciFetch(input, { ...init, redirect, dispatcher, signal });
    return limitResponse(response, href, maxBytes, deadline, timeoutMs);
  };
  // undici's fetch is the implementation behind Node's; only its type declarations differ.
  return guarded as unknown as typeof fetch;
};
