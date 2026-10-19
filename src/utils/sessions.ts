/**
 * Stored, rotating refresh tokens (server-only).
 *
 * A sign-in creates a SESSION (a token family, identified by `sessionId`) and an opaque refresh
 * token. Only the token's SHA-256 hash is stored. Each refresh:
 *  - looks the token up by hash and rejects it if it is unknown, revoked or expired;
 *  - replaces it with a new token in the same session (the old record gets `revokedAt` and
 *    `replacedBy`).
 * Presenting a token that was already replaced means two parties hold the same token, so the
 * whole session is revoked — unless it happens within REFRESH_REUSE_GRACE_MS of the rotation and
 * the session is still alive, which is what two tabs refreshing at once (or a response lost to a
 * navigation) look like. In that case the caller gets a new access token and a fresh refresh
 * token in the same session, because a browser holding an httpOnly cookie cannot recover the
 * replacement it missed (see `rotateRefreshToken`).
 *
 * Signing out revokes the session; a password reset revokes every session of the account; removing
 * the account deletes its records.
 *
 * Session lifetime: a session ends when it has not been refreshed for `AUTH_SESSION_IDLE_TTL`
 * (idle timeout, sliding on every refresh) and at the latest `AUTH_SESSION_MAX_TTL` after its
 * sign-in (absolute lifetime). Each refresh token expires at the earliest of its own lifetime and
 * these two limits; a refresh past either limit revokes the session.
 *
 * Revoked and expired records are deleted by `cleanupExpiredSessions` once they are old enough
 * (see `startSessionCleanup` for the daily run the backend provider starts).
 */
import { sharedState } from '@_linked/core/utils/sharedState';
import crypto from 'node:crypto';
import { RefreshToken } from '../shapes/RefreshToken.js';
import {
  REFRESH_TOKEN_EXPIRES,
  SESSION_IDLE_TTL,
  SESSION_MAX_TTL,
  readTtlFromEnv,
} from './token.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  looksLikeOpaqueRefreshToken,
} from './refreshTokenHash.js';
import { toDate } from './date.js';

export { generateRefreshToken, hashRefreshToken };

/** How long after a rotation the replaced token is still tolerated (concurrent tabs). */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000;

export interface RefreshSessionRecord {
  /** The store's identifier of the record (graph node IRI). */
  id?: string;
  tokenHash: string;
  sessionId: string;
  accountId: string;
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt: Date;
  revokedAt?: Date;
  replacedBy?: string;
  /** When the session's sign-in happened. Absent on records from before it was stored. */
  sessionStartedAt?: Date;
}

/**
 * Where refresh token records live. The default stores them as `RefreshToken` shapes through
 * the app's configured storage; tests can swap in `MemoryRefreshSessionStore`.
 */
export interface RefreshSessionStore {
  create(record: RefreshSessionRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<RefreshSessionRecord | null>;
  findBySessionId(sessionId: string): Promise<RefreshSessionRecord[]>;
  findByAccount(accountId: string): Promise<RefreshSessionRecord[]>;
  update(
    record: RefreshSessionRecord,
    patch: Partial<Pick<RefreshSessionRecord, 'lastUsedAt' | 'revokedAt' | 'replacedBy'>>
  ): Promise<void>;
  delete(record: RefreshSessionRecord): Promise<void>;
  /**
   * Records revoked or expired before `cutoff` (for `cleanupExpiredSessions`). Optional: a store
   * without it is not cleaned up.
   */
  findStale?(cutoff: Date): Promise<RefreshSessionRecord[]>;
}

function idOf(value: any): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return value.id;
}

/** Stores refresh token records as `RefreshToken` shapes in the app's storage. */
export class GraphRefreshSessionStore implements RefreshSessionStore {
  private static select() {
    return RefreshToken.select((t) => [
      t.tokenHash,
      t.sessionId,
      t.account,
      t.createdAt,
      t.lastUsedAt,
      t.expiresAt,
      t.revokedAt,
      t.replacedBy,
      t.sessionStartedAt,
    ]);
  }

  private static toRecord(row: any): RefreshSessionRecord | null {
    if (!row || !row.tokenHash) return null;
    return {
      id: row.id,
      tokenHash: row.tokenHash,
      sessionId: row.sessionId,
      accountId: idOf(row.account),
      createdAt: toDate(row.createdAt),
      lastUsedAt: toDate(row.lastUsedAt),
      expiresAt: toDate(row.expiresAt),
      revokedAt: toDate(row.revokedAt),
      replacedBy: row.replacedBy || undefined,
      sessionStartedAt: toDate(row.sessionStartedAt),
    };
  }

  async create(record: RefreshSessionRecord): Promise<void> {
    const created = await RefreshToken.create({
      tokenHash: record.tokenHash,
      sessionId: record.sessionId,
      account: { id: record.accountId },
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
      ...(record.sessionStartedAt ? { sessionStartedAt: record.sessionStartedAt } : {}),
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
      ...(record.replacedBy ? { replacedBy: record.replacedBy } : {}),
    });
    record.id = created?.id;
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshSessionRecord | null> {
    const rows = await GraphRefreshSessionStore.select().where((t) =>
      t.tokenHash.equals(tokenHash)
    );
    return GraphRefreshSessionStore.toRecord(rows?.[0]);
  }

  async findBySessionId(sessionId: string): Promise<RefreshSessionRecord[]> {
    const rows = await GraphRefreshSessionStore.select().where((t) =>
      t.sessionId.equals(sessionId)
    );
    return (rows || []).map(GraphRefreshSessionStore.toRecord).filter(Boolean);
  }

  async findByAccount(accountId: string): Promise<RefreshSessionRecord[]> {
    const rows = await GraphRefreshSessionStore.select().where((t) =>
      t.account.equals({ id: accountId })
    );
    return (rows || []).map(GraphRefreshSessionStore.toRecord).filter(Boolean);
  }

  async update(
    record: RefreshSessionRecord,
    patch: Partial<Pick<RefreshSessionRecord, 'lastUsedAt' | 'revokedAt' | 'replacedBy'>>
  ): Promise<void> {
    const id = record.id ?? (await this.findByTokenHash(record.tokenHash))?.id;
    if (!id) return;
    const data: Partial<Pick<RefreshSessionRecord, 'lastUsedAt' | 'revokedAt' | 'replacedBy'>> = {};
    if (patch.lastUsedAt !== undefined) data.lastUsedAt = patch.lastUsedAt;
    if (patch.revokedAt !== undefined) data.revokedAt = patch.revokedAt;
    if (patch.replacedBy !== undefined) data.replacedBy = patch.replacedBy;
    if (Object.keys(data).length === 0) return;
    await RefreshToken.update(data).for({ id });
    Object.assign(record, patch);
  }

  async delete(record: RefreshSessionRecord): Promise<void> {
    const id = record.id ?? (await this.findByTokenHash(record.tokenHash))?.id;
    if (!id) return;
    await RefreshToken.delete({ id });
  }

  async findStale(cutoff: Date): Promise<RefreshSessionRecord[]> {
    // Two simple queries rather than one OR: each is a plain range filter on one property.
    const [expired, revoked] = await Promise.all([
      GraphRefreshSessionStore.select().where((t) => (t.expiresAt as any).lt(cutoff)),
      GraphRefreshSessionStore.select().where((t) => (t.revokedAt as any).lt(cutoff)),
    ]);
    const byId = new Map<string, RefreshSessionRecord>();
    for (const row of [...(expired || []), ...(revoked || [])]) {
      const record = GraphRefreshSessionStore.toRecord(row);
      if (record) byId.set(record.id ?? record.tokenHash, record);
    }
    return [...byId.values()];
  }
}

/** Keeps refresh token records in memory. For tests and single-process tooling only. */
export class MemoryRefreshSessionStore implements RefreshSessionStore {
  readonly records = new Map<string, RefreshSessionRecord>();

  async create(record: RefreshSessionRecord): Promise<void> {
    record.id = record.id ?? `memory:${record.tokenHash}`;
    this.records.set(record.tokenHash, { ...record });
  }
  async findByTokenHash(tokenHash: string) {
    const record = this.records.get(tokenHash);
    return record ? { ...record } : null;
  }
  async findBySessionId(sessionId: string) {
    return [...this.records.values()]
      .filter((r) => r.sessionId === sessionId)
      .map((r) => ({ ...r }));
  }
  async findByAccount(accountId: string) {
    return [...this.records.values()]
      .filter((r) => r.accountId === accountId)
      .map((r) => ({ ...r }));
  }
  async update(record: RefreshSessionRecord, patch: Partial<RefreshSessionRecord>) {
    const stored = this.records.get(record.tokenHash);
    if (stored) Object.assign(stored, patch);
    Object.assign(record, patch);
  }
  async delete(record: RefreshSessionRecord) {
    this.records.delete(record.tokenHash);
  }
  async findStale(cutoff: Date) {
    return [...this.records.values()]
      .filter(
        (r) =>
          (r.expiresAt && r.expiresAt < cutoff) || (r.revokedAt && r.revokedAt < cutoff)
      )
      .map((r) => ({ ...r }));
  }
}

/**
 * The refresh session store, the session limits and the rotations under way, shared by every copy
 * of this module in the runtime: a store or limits set through one copy hold for the other, and
 * two copies never rotate one refresh token at once (that would look like reuse). See
 * https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md.
 */
const sessionState = sharedState('@_linked/auth', 'sessions', () => ({
  store: new GraphRefreshSessionStore() as RefreshSessionStore,
  limits: {
    idleTtl: SESSION_IDLE_TTL,
    maxTtl: SESSION_MAX_TTL,
    refreshTtl: REFRESH_TOKEN_EXPIRES,
  } as SessionLimits,
  inFlight: new Map<string, Promise<RotateResult>>(),
}));

/** Replace where refresh token records are kept (defaults to the graph via `RefreshToken`). */
export function setRefreshSessionStore(newStore: RefreshSessionStore) {
  sessionState.store = newStore;
}
export function getRefreshSessionStore(): RefreshSessionStore {
  return sessionState.store;
}

/** A new session identifier (the token family shared by every rotation of one sign-in). */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

/** Session lifetime limits in seconds (0 = no limit). Defaults from the environment. */
export interface SessionLimits {
  idleTtl: number;
  maxTtl: number;
  refreshTtl: number;
}

/** The session limits in force. */
export function getSessionLimits(): SessionLimits {
  return { ...sessionState.limits };
}

/**
 * Override session limits (seconds; 0 = no limit) — for tests and tooling. Apps configure them
 * with `AUTH_SESSION_IDLE_TTL`, `AUTH_SESSION_MAX_TTL` and `AUTH_REFRESH_TOKEN_TTL`.
 */
export function setSessionLimits(newLimits: Partial<SessionLimits>) {
  sessionState.limits = { ...sessionState.limits, ...newLimits };
}

/**
 * When a refresh token issued at `now` in a session that started at `sessionStartedAt` expires:
 * the earliest of its own lifetime, the idle timeout and the session's absolute lifetime.
 */
export function refreshTokenExpiresAt(now: Date, sessionStartedAt: Date = now): Date {
  const { limits } = sessionState;
  let expires = now.getTime() + limits.refreshTtl * 1000;
  if (limits.idleTtl > 0) {
    expires = Math.min(expires, now.getTime() + limits.idleTtl * 1000);
  }
  if (limits.maxTtl > 0) {
    expires = Math.min(expires, sessionStartedAt.getTime() + limits.maxTtl * 1000);
  }
  return new Date(expires);
}

/**
 * Store a new refresh token for an account and return the raw token.
 * Starts a new session unless `sessionId` is given; a rotation passes the session's start.
 */
export async function issueRefreshToken(
  accountId: string,
  sessionId: string = generateSessionId(),
  now: Date = new Date(),
  sessionStartedAt: Date = now
): Promise<{ refreshToken: string; sessionId: string; expiresAt: Date }> {
  if (!accountId) {
    throw new Error('@_linked/auth: cannot issue a refresh token without an account id');
  }
  const refreshToken = generateRefreshToken();
  const expiresAt = refreshTokenExpiresAt(now, sessionStartedAt);
  await sessionState.store.create({
    tokenHash: hashRefreshToken(refreshToken),
    sessionId,
    accountId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt,
    sessionStartedAt,
  });
  return { refreshToken, sessionId, expiresAt };
}

/** When a record's session started: stored on the record, else its family's first createdAt. */
async function sessionStartOf(record: RefreshSessionRecord): Promise<Date> {
  if (record.sessionStartedAt) return record.sessionStartedAt;
  const family = await sessionState.store.findBySessionId(record.sessionId);
  let start = record.createdAt;
  for (const member of family) {
    if (member.createdAt && (!start || member.createdAt < start)) start = member.createdAt;
  }
  return start ?? new Date(0);
}

export type RotateResult =
  | {
      ok: true;
      accountId: string;
      sessionId: string;
      /** The replacement token (also on a grace-window reuse: a fresh token in the same session). */
      refreshToken?: string;
      /** When the replacement token expires (absent with it). */
      refreshTokenExpiresAt?: Date;
    }
  | {
      ok: false;
      /**
       * - `idle`: the session was not refreshed within AUTH_SESSION_IDLE_TTL;
       * - `session-expired`: the session is older than AUTH_SESSION_MAX_TTL.
       * Both revoke the session.
       */
      reason:
        | 'malformed'
        | 'unknown'
        | 'expired'
        | 'revoked'
        | 'reused'
        | 'idle'
        | 'session-expired';
    };

function isActive(record: RefreshSessionRecord, now: Date) {
  return !record.revokedAt && record.expiresAt && record.expiresAt > now;
}

/**
 * Is the session that `record` was rotated out of still alive? Follows `replacedBy` to the
 * newest token, tolerating a chain of rotations that all happened within the grace window.
 */
async function successorIsAlive(record: RefreshSessionRecord, now: Date) {
  let current = record;
  for (let i = 0; i < 5; i++) {
    if (!current.replacedBy) return false;
    const next = await sessionState.store.findByTokenHash(current.replacedBy);
    if (!next || next.sessionId !== record.sessionId) return false;
    if (isActive(next, now)) return true;
    if (
      !next.replacedBy ||
      !next.revokedAt ||
      now.getTime() - next.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS
    ) {
      return false;
    }
    current = next;
  }
  return false;
}

/**
 * Validate a raw refresh token and replace it with a new one in the same session.
 * See the module comment for the reuse and grace-window rules.
 */
export function rotateRefreshToken(
  rawToken: string,
  now: Date = new Date()
): Promise<RotateResult> {
  if (!looksLikeOpaqueRefreshToken(rawToken)) {
    // Includes every refresh token issued before tokens were stored (those were JWTs).
    return Promise.resolve({ ok: false, reason: 'malformed' });
  }
  const tokenHash = hashRefreshToken(rawToken);
  // Two requests in this process presenting the same token: the second one waits for the
  // first and is then treated as a grace-window reuse rather than a theft.
  const pending = sessionState.inFlight.get(tokenHash);
  if (pending) {
    return pending.then(() => doRotate(tokenHash, now));
  }
  const { inFlight } = sessionState;
  const promise = doRotate(tokenHash, now).finally(() => inFlight.delete(tokenHash));
  inFlight.set(tokenHash, promise);
  return promise;
}

async function doRotate(tokenHash: string, now: Date): Promise<RotateResult> {
  const record = await sessionState.store.findByTokenHash(tokenHash);
  if (!record) {
    return { ok: false, reason: 'unknown' };
  }

  if (record.revokedAt) {
    const sinceRevoked = now.getTime() - record.revokedAt.getTime();
    if (record.replacedBy && sinceRevoked <= REFRESH_REUSE_GRACE_MS) {
      if (await successorIsAlive(record, now)) {
        // The caller missed the response that carried the replacement (a navigation aborted
        // it, or another tab sent the same cookie at the same moment). With an httpOnly cookie
        // it cannot recover that token, so it gets a fresh one in the same session. Without
        // this, the token it still holds would count as reuse after the grace window and end
        // the session. The replaced record keeps pointing at its first successor, so presenting
        // it AFTER the grace window is still detected as reuse.
        const sessionStartedAt = await sessionStartOf(record);
        const next = await issueRefreshToken(
          record.accountId,
          record.sessionId,
          now,
          sessionStartedAt
        );
        return {
          ok: true,
          accountId: record.accountId,
          sessionId: record.sessionId,
          refreshToken: next.refreshToken,
          refreshTokenExpiresAt: next.expiresAt,
        };
      }
      return { ok: false, reason: 'revoked' };
    }
    if (record.replacedBy) {
      // A replaced token presented again: someone else has (had) it. End the session.
      console.warn(
        `@_linked/auth: refresh token reuse detected, revoking session ${record.sessionId}`
      );
      await revokeSession(record.sessionId, now);
      return { ok: false, reason: 'reused' };
    }
    return { ok: false, reason: 'revoked' };
  }

  if (!record.expiresAt || record.expiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }

  // Session limits. New records already expire at the earlier limit, so this mostly catches
  // records issued before the limits existed (or before they were lowered).
  const lastUsed = record.lastUsedAt ?? record.createdAt;
  const { limits } = sessionState;
  if (limits.idleTtl > 0 && lastUsed && now.getTime() - lastUsed.getTime() > limits.idleTtl * 1000) {
    await revokeSession(record.sessionId, now);
    return { ok: false, reason: 'idle' };
  }
  const sessionStartedAt = await sessionStartOf(record);
  if (limits.maxTtl > 0 && now.getTime() - sessionStartedAt.getTime() > limits.maxTtl * 1000) {
    await revokeSession(record.sessionId, now);
    return { ok: false, reason: 'session-expired' };
  }

  // Create the replacement first: if revoking the old record fails, the user keeps a working
  // session rather than losing it.
  const next = await issueRefreshToken(
    record.accountId,
    record.sessionId,
    now,
    sessionStartedAt
  );
  await sessionState.store.update(record, {
    revokedAt: now,
    replacedBy: hashRefreshToken(next.refreshToken),
    lastUsedAt: now,
  });
  return {
    ok: true,
    accountId: record.accountId,
    sessionId: record.sessionId,
    refreshToken: next.refreshToken,
    refreshTokenExpiresAt: next.expiresAt,
  };
}

/** The session a raw refresh token belongs to, if it is known. Does not validate it. */
export async function findSessionIdForRefreshToken(
  rawToken: string
): Promise<string | undefined> {
  if (!looksLikeOpaqueRefreshToken(rawToken)) return undefined;
  const record = await sessionState.store.findByTokenHash(hashRefreshToken(rawToken));
  return record?.sessionId;
}

/**
 * When a raw refresh token expires, if it is known and still usable (not revoked, not expired).
 * Lets the server tell the client how long to keep a refresh token it echoes back.
 */
export async function findRefreshTokenExpiry(
  rawToken: string,
  now: Date = new Date()
): Promise<Date | undefined> {
  if (!looksLikeOpaqueRefreshToken(rawToken)) return undefined;
  const record = await sessionState.store.findByTokenHash(hashRefreshToken(rawToken));
  return record && isActive(record, now) ? record.expiresAt : undefined;
}

/** Revoke every token of one session (sign-out, or detected reuse). Returns how many were revoked. */
export async function revokeSession(
  sessionId: string,
  now: Date = new Date()
): Promise<number> {
  if (!sessionId) return 0;
  const records = await sessionState.store.findBySessionId(sessionId);
  let revoked = 0;
  for (const record of records) {
    if (!record.revokedAt) {
      await sessionState.store.update(record, { revokedAt: now });
      revoked++;
    }
  }
  return revoked;
}

/** Revoke every session of an account (password reset / change). Returns how many tokens were revoked. */
export async function revokeAllSessionsForAccount(
  accountId: string,
  now: Date = new Date()
): Promise<number> {
  if (!accountId) return 0;
  const records = await sessionState.store.findByAccount(accountId);
  let revoked = 0;
  for (const record of records) {
    if (!record.revokedAt) {
      await sessionState.store.update(record, { revokedAt: now });
      revoked++;
    }
  }
  return revoked;
}

/** Delete every refresh token record of an account (account removal). */
export async function deleteAllSessionsForAccount(accountId: string): Promise<number> {
  if (!accountId) return 0;
  const records = await sessionState.store.findByAccount(accountId);
  for (const record of records) {
    await sessionState.store.delete(record);
  }
  return records.length;
}

/** Default retention of revoked/expired records before cleanup deletes them: 30 days. */
export const DEFAULT_CLEANUP_AFTER_SECONDS = 30 * 24 * 60 * 60;

/**
 * Delete refresh token records that were revoked or expired more than `olderThan` seconds ago.
 * Active records, and recently revoked ones (still needed to detect reuse of a rotated token),
 * are kept. Returns how many records were deleted.
 *
 * @param targetStore defaults to the configured store
 * @param options.olderThan seconds (default 30 days, or `AUTH_SESSION_CLEANUP_AFTER`)
 */
export async function cleanupExpiredSessions(
  targetStore: RefreshSessionStore = sessionState.store,
  {
    olderThan = readTtlFromEnv('AUTH_SESSION_CLEANUP_AFTER', DEFAULT_CLEANUP_AFTER_SECONDS),
    now = new Date(),
  }: { olderThan?: number; now?: Date } = {}
): Promise<number> {
  if (typeof targetStore.findStale !== 'function') {
    console.warn('@_linked/auth: this refresh session store cannot be cleaned up (no findStale)');
    return 0;
  }
  const cutoff = new Date(now.getTime() - olderThan * 1000);
  const stale = await targetStore.findStale(cutoff);
  let deleted = 0;
  for (const record of stale) {
    // re-check: a store may return a superset
    const eligible =
      (record.revokedAt && record.revokedAt < cutoff) ||
      (record.expiresAt && record.expiresAt < cutoff);
    if (!eligible) continue;
    await targetStore.delete(record);
    deleted++;
  }
  return deleted;
}

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Delay before the first run, so cleanup never competes with startup. */
const CLEANUP_FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
let lastCleanupAt = 0;
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Run `cleanupExpiredSessions` in the background: first a few minutes after startup, then at most
 * once a day per process (also across provider re-setup on hot reload). Never blocks, never
 * throws: errors are logged. Off when `AUTH_SESSION_CLEANUP=false` (e.g. when several processes
 * share a store and one job does it). Returns a function that stops it.
 */
export function startSessionCleanup(): () => void {
  stopSessionCleanup();
  const setting = (process.env.AUTH_SESSION_CLEANUP || '').toLowerCase();
  if (setting === 'false' || setting === '0' || setting === 'off') {
    return stopSessionCleanup;
  }
  const run = () => {
    const now = Date.now();
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = now;
    cleanupExpiredSessions()
      .then((deleted) => {
        if (deleted > 0) {
          console.log(`@_linked/auth: deleted ${deleted} expired or revoked refresh token records`);
        }
      })
      .catch((err) =>
        console.warn('@_linked/auth: refresh token cleanup failed', err?.message ?? err)
      );
  };
  const sinceLast = Date.now() - lastCleanupAt;
  const firstDelay = Math.max(CLEANUP_FIRST_RUN_DELAY_MS, CLEANUP_INTERVAL_MS - sinceLast);
  const schedule = (delay: number) => {
    cleanupTimer = setTimeout(() => {
      run();
      schedule(CLEANUP_INTERVAL_MS);
    }, delay);
    // never keep the process alive for this
    (cleanupTimer as any)?.unref?.();
  };
  schedule(lastCleanupAt ? firstDelay : CLEANUP_FIRST_RUN_DELAY_MS);
  return stopSessionCleanup;
}

export function stopSessionCleanup() {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = undefined;
  }
}
