/**
 * Rate limits for the auth calls that check a credential, send an email or create something.
 *
 * Each rule limits a call by the client's IP address and, where the call names an account (an
 * email, or the signed-in account), by that account as well. An account is counted whether or not
 * it exists, so a limited answer never tells a caller that an account exists.
 *
 * The counting is a sliding window: the count of the current fixed window plus the previous
 * window's count weighted by how much of it still overlaps. That smooths the double burst a plain
 * fixed window allows at its boundary, and needs only two counters per key, which any shared store
 * (Redis INCR + PEXPIRE, a database row) can keep. Every attempt is counted, including one that is
 * refused, so a client that keeps trying stays limited.
 *
 * The default store keeps its counters in memory, so **the limits are per process**: N instances
 * behind a load balancer allow up to N times the limit. Give every instance one shared store with
 * `setRateLimitStore` to make the limits global.
 *
 * The client IP is what Express resolves as `request.ip`. Behind a reverse proxy that is the
 * proxy's address unless the app sets Express's `trust proxy`, and then every client shares one
 * bucket per rule; set `trust proxy` to exactly the proxies in front of the app. X-Forwarded-For is
 * never read here directly, since any client can send it.
 *
 * Configuration (environment, read on every check):
 * - `AUTH_RATE_LIMIT=off` turns every limit off (e.g. for a test run). `false` and `0` do too.
 * - `AUTH_RATE_LIMIT_<RULE>_<IP|ACCOUNT>=<max>/<windowSeconds>` overrides one limit, e.g.
 *   `AUTH_RATE_LIMIT_SIGNIN_IP=20/60`. `off` or `0` turns that one limit off.
 *
 * `configureRateLimits` overrides the same values in code; the environment wins over it.
 */

/** A limit: at most `max` attempts in any `windowSeconds`. */
export type RateLimit = { max: number; windowSeconds: number };

/** What a rule counts by. A missing or `null` limit is not enforced. */
export type RateLimitRule = { ip?: RateLimit | null; account?: RateLimit | null };

export type RateLimitRuleName =
  | 'signin'
  | 'signup'
  | 'passwordResetRequest'
  | 'passwordReset'
  | 'passwordChange'
  | 'tokenRefresh'
  | 'oauth'
  | 'temporarySignin'
  | 'credentialLookup'
  | 'emailVerificationRequest'
  | 'emailVerify'
  | 'signinCodeRequest'
  | 'signinCode'
  | 'reauthenticate';

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * The default limits. Generous enough that a person using the app never meets them, tight enough
 * that guessing passwords or sending reset emails in bulk does not work.
 */
export const RATE_LIMIT_DEFAULTS: Readonly<Record<RateLimitRuleName, RateLimitRule>> = {
  /** `signinWithPassword`: by IP, and by the email signed in to. */
  signin: { ip: { max: 10, windowSeconds: MINUTE }, account: { max: 5, windowSeconds: MINUTE } },
  /** `createAccount`. Its "email already in use" answer can enumerate accounts. */
  signup: { ip: { max: 10, windowSeconds: HOUR } },
  /** `sendResetPasswordLink`: each one sends an email. */
  passwordResetRequest: {
    ip: { max: 10, windowSeconds: HOUR },
    account: { max: 3, windowSeconds: HOUR },
  },
  /** `resetPassword` with a reset token. */
  passwordReset: { ip: { max: 10, windowSeconds: MINUTE } },
  /** `resetPassword` without a token: a signed-in change, which checks the current password. */
  passwordChange: {
    ip: { max: 10, windowSeconds: MINUTE },
    account: { max: 5, windowSeconds: 15 * MINUTE },
  },
  /** `validateToken` when it exchanges a refresh token. A valid access token is not counted. */
  tokenRefresh: { ip: { max: 60, windowSeconds: MINUTE } },
  /** `signinOAuth` and `linkOAuthIdentity` (by the signed-in account). */
  oauth: { ip: { max: 20, windowSeconds: MINUTE }, account: { max: 10, windowSeconds: MINUTE } },
  /** `signinTemporary`: each one creates a person and an account. */
  temporarySignin: { ip: { max: 30, windowSeconds: HOUR } },
  /** `hasAuthCredential`: tells whether a person has a credential. */
  credentialLookup: { ip: { max: 60, windowSeconds: MINUTE } },
  /** `resendEmailVerification`: each one sends an email. By the signed-in account. */
  emailVerificationRequest: {
    ip: { max: 10, windowSeconds: HOUR },
    account: { max: 3, windowSeconds: HOUR },
  },
  /** `verifyEmail`: guessing a verification token. */
  emailVerify: { ip: { max: 10, windowSeconds: MINUTE } },
  /** `sendSigninCode`: each one sends an email. By IP, and by the email asked for. */
  signinCodeRequest: {
    ip: { max: 10, windowSeconds: HOUR },
    account: { max: 3, windowSeconds: HOUR },
  },
  /** `signinWithCode`: guessing an eight-digit code. By IP, and by the email it was sent to. */
  signinCode: {
    ip: { max: 10, windowSeconds: MINUTE },
    account: { max: 5, windowSeconds: 15 * MINUTE },
  },
  /** `removeAccount` when it checks a password or ID token. By the signed-in account. */
  reauthenticate: {
    ip: { max: 10, windowSeconds: MINUTE },
    account: { max: 5, windowSeconds: 15 * MINUTE },
  },
};

/**
 * Where the counters live. Both methods may return a promise, so a shared store (Redis, a
 * database) can implement it. `increment` must be atomic: it is the only write, and the limit is
 * decided from the count it returns.
 */
export interface RateLimitStore {
  /** Add one to `key` and return the new count. The store may drop the key after `ttlMs`. */
  increment(key: string, ttlMs: number): Promise<number> | number;
  /** The count of `key`, 0 when it does not exist (or has expired). */
  get(key: string): Promise<number> | number;
}

/**
 * Counters in this process's memory. Expired counters are swept at most every `sweepEveryMs`, on
 * a write; there is no timer. Should the number of keys still pass `maxKeys` after a sweep (a flood
 * of distinct emails or addresses), the oldest keys are dropped, which can only make a limit more
 * lenient, never block someone.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private counters = new Map<string, { count: number; expiresAt: number }>();
  private lastSweep = 0;

  constructor(
    private options: { maxKeys?: number; sweepEveryMs?: number; now?: () => number } = {}
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  increment(key: string, ttlMs: number): number {
    const now = this.now();
    this.sweep(now);
    const current = this.counters.get(key);
    if (current && current.expiresAt > now) {
      current.count += 1;
      return current.count;
    }
    // delete first, so a re-created key moves to the end of the insertion order
    this.counters.delete(key);
    this.counters.set(key, { count: 1, expiresAt: now + ttlMs });
    return 1;
  }

  get(key: string): number {
    const current = this.counters.get(key);
    return current && current.expiresAt > this.now() ? current.count : 0;
  }

  /** How many counters are held, expired ones included until the next sweep. */
  get size(): number {
    return this.counters.size;
  }

  clear(): void {
    this.counters.clear();
  }

  private sweep(now: number): void {
    const maxKeys = this.options.maxKeys ?? 100_000;
    const sweepEveryMs = this.options.sweepEveryMs ?? 60_000;
    if (now - this.lastSweep < sweepEveryMs && this.counters.size < maxKeys) return;
    this.lastSweep = now;
    for (const [key, counter] of this.counters) {
      if (counter.expiresAt <= now) this.counters.delete(key);
    }
    // Map iterates in insertion order: the first keys are the oldest windows
    for (const key of this.counters.keys()) {
      if (this.counters.size < maxKeys) break;
      this.counters.delete(key);
    }
  }
}

let store: RateLimitStore = new MemoryRateLimitStore();
let overrides: Partial<Record<RateLimitRuleName, RateLimitRule>> = {};

/** Use `next` for every counter from now on (e.g. a store shared by every instance). */
export function setRateLimitStore(next: RateLimitStore): void {
  store = next;
}

export function getRateLimitStore(): RateLimitStore {
  return store;
}

/**
 * Override limits in code, per rule and per kind (`ip`/`account`); `null` turns one off. Replaces
 * the overrides of an earlier call. Environment variables still win.
 */
export function configureRateLimits(
  next: Partial<Record<RateLimitRuleName, RateLimitRule>> = {}
): void {
  overrides = next;
}

/** Forget every override and start over with an empty in-memory store. For tests. */
export function resetRateLimits(): void {
  overrides = {};
  store = new MemoryRateLimitStore();
}

/** False when `AUTH_RATE_LIMIT` turns limiting off. */
export function rateLimitingEnabled(): boolean {
  const value = (process.env.AUTH_RATE_LIMIT ?? '').trim().toLowerCase();
  return !['off', 'false', '0', 'no'].includes(value);
}

/** `max/windowSeconds`, `off` or `0`; undefined for an unset or malformed value. */
export function parseRateLimit(value: string | undefined): RateLimit | null | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  if (text === '') return undefined;
  if (text === 'off' || text === '0' || text === 'false') return null;
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (!match) {
    console.warn(`@_linked/auth: ignoring a rate limit that is not <max>/<seconds>: ${value}`);
    return undefined;
  }
  const max = Number(match[1]);
  const windowSeconds = Number(match[2]);
  if (max === 0 || windowSeconds === 0) return null;
  return { max, windowSeconds };
}

function envName(rule: RateLimitRuleName, kind: keyof RateLimitRule): string {
  const snake = rule.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  return `AUTH_RATE_LIMIT_${snake}_${kind.toUpperCase()}`;
}

/** The limit in force for one rule and kind, or null when there is none. */
export function resolveRateLimit(
  rule: RateLimitRuleName,
  kind: keyof RateLimitRule
): RateLimit | null {
  const fromEnv = parseRateLimit(process.env[envName(rule, kind)]);
  if (fromEnv !== undefined) return fromEnv;
  const override = overrides[rule];
  if (override && kind in override) return override[kind] ?? null;
  return RATE_LIMIT_DEFAULTS[rule][kind] ?? null;
}

/**
 * The sliding-window estimate: the current window's count plus the previous window's, weighted by
 * the part of it that still lies inside the sliding window.
 */
export function slidingWindowCount(
  previous: number,
  current: number,
  elapsedFraction: number
): number {
  return previous * (1 - elapsedFraction) + current;
}

/**
 * Seconds until one more attempt fits under `max` again, assuming no further attempts. At least 1.
 */
export function secondsUntilAllowed(
  previous: number,
  current: number,
  max: number,
  windowMs: number,
  elapsedMs: number
): number {
  // still in this window: previous * (1 - f) + current + 1 <= max
  if (previous > 0 && current + 1 <= max) {
    const f = 1 - (max - 1 - current) / previous;
    const waitMs = f * windowMs - elapsedMs;
    if (waitMs <= windowMs - elapsedMs) return Math.max(1, Math.ceil(waitMs / 1000));
  }
  // in the next window, where `current` becomes the previous count: current * (1 - g) + 1 <= max
  const g = current > 0 ? Math.max(0, 1 - (max - 1) / current) : 0;
  const waitMs = windowMs - elapsedMs + g * windowMs;
  return Math.max(1, Math.ceil(waitMs / 1000));
}

export type RateLimitDecision =
  | { limited: false }
  | { limited: true; retryAfter: number; kind: keyof RateLimitRule };

/**
 * Count one attempt for `rule` by `ip` and `account` (either may be missing, and then is not
 * counted) and decide whether it is over a limit. Both are counted even when the first is already
 * over, so a client cannot spend one budget while the other recovers.
 */
export async function consumeRateLimit(
  rule: RateLimitRuleName,
  keys: { ip?: string | null; account?: string | null },
  now: number = Date.now()
): Promise<RateLimitDecision> {
  if (!rateLimitingEnabled()) return { limited: false };
  let decision: RateLimitDecision = { limited: false };
  for (const kind of ['ip', 'account'] as const) {
    const id = keys[kind];
    const limit = resolveRateLimit(rule, kind);
    if (!id || !limit) continue;
    const windowMs = limit.windowSeconds * 1000;
    const windowIndex = Math.floor(now / windowMs);
    const elapsedMs = now - windowIndex * windowMs;
    const base = `auth:${rule}:${kind}:${limit.windowSeconds}:${id}`;
    // a counter is read during its own window and the next one
    const current = await store.increment(`${base}:${windowIndex}`, windowMs * 2);
    const previous = await store.get(`${base}:${windowIndex - 1}`);
    const count = slidingWindowCount(previous, current, elapsedMs / windowMs);
    if (count > limit.max) {
      const retryAfter = secondsUntilAllowed(previous, current, limit.max, windowMs, elapsedMs);
      if (!decision.limited || retryAfter > decision.retryAfter) {
        decision = { limited: true, retryAfter, kind };
      }
    }
  }
  return decision;
}

/** An email as an account key: trimmed and lower-cased, so `Ada@x` and `ada@x ` share a budget. */
export function normalizeAccountKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return key || null;
}

/**
 * The client address of an HTTP request, as Express resolves it (`request.ip`, which follows the
 * app's `trust proxy` setting), else the socket's peer address. Null when there is none.
 */
export function clientIp(request: unknown): string | null {
  if (!request || typeof request !== 'object') return null;
  const req = request as { ip?: unknown; socket?: { remoteAddress?: unknown } };
  if (typeof req.ip === 'string' && req.ip) return req.ip;
  const remote = req.socket?.remoteAddress;
  return typeof remote === 'string' && remote ? remote : null;
}

/** What a limited call answers. The same for every account, existing or not. */
export type RateLimitedResult = { error: string; action: 'rate_limited'; retryAfter: number };

export const RATE_LIMITED_MESSAGE = 'Too many attempts. Please wait a moment and try again.';

/**
 * Count one attempt of an HTTP call and answer it if it is over a limit: a `RateLimitedResult`,
 * with a `Retry-After` header on the response. Null when the call may go ahead. A call made outside
 * any HTTP request (a job, a script) is never limited; backend code that calls a limited method
 * while serving a request counts against that request's client.
 */
export async function limitRequest(
  rule: RateLimitRuleName,
  request: unknown,
  response: unknown,
  account?: unknown
): Promise<RateLimitedResult | null> {
  if (!request) return null;
  const decision = await consumeRateLimit(rule, {
    ip: clientIp(request),
    account: normalizeAccountKey(account),
  });
  if (!decision.limited) return null;
  // the rule and kind only: never the address or the email
  console.warn(`@_linked/auth: rate limit reached for ${rule} (${decision.kind})`);
  const res = response as
    | { headersSent?: boolean; setHeader?: (name: string, value: string) => void }
    | undefined;
  if (res && !res.headersSent && typeof res.setHeader === 'function') {
    res.setHeader('Retry-After', String(decision.retryAfter));
  }
  return { error: RATE_LIMITED_MESSAGE, action: 'rate_limited', retryAfter: decision.retryAfter };
}
