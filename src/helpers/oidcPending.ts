/**
 * Pending Solid-OIDC sign-ins, kept in the browser's server-side session (express-session) and
 * keyed by `state`. Holding them in the session that started the sign-in binds the callback to
 * that browser: a callback URL opened in another browser finds nothing (login CSRF), and a record
 * is removed the first time its `state` is looked up.
 */
import type { PendingOidcSignin } from '../utils/oidcSignin.js';

/** The session key the pending sign-ins live under. */
export const OIDC_PENDING_SESSION_KEY = 'linkedAuthOidc';

/** How long a sign-in may take at the issuer. */
export const OIDC_PENDING_TTL_MS = 10 * 60 * 1000;

/** Sign-ins one browser may have under way at once (tabs); the oldest goes first. */
export const OIDC_MAX_PENDING = 5;

export type PendingOidcRecord = PendingOidcSignin & { returnTo?: string };

type SessionLike = Record<string, unknown> | undefined | null;

const pendingOf = (session: SessionLike): Record<string, PendingOidcRecord> => {
  const value = session?.[OIDC_PENDING_SESSION_KEY];
  return value && typeof value === 'object' ? (value as Record<string, PendingOidcRecord>) : {};
};

const isLive = (record: PendingOidcRecord, now: number): boolean =>
  typeof record?.createdAt === 'number' && now - record.createdAt < OIDC_PENDING_TTL_MS;

/**
 * Keep `record` in `session`, dropping expired records and the oldest beyond `OIDC_MAX_PENDING`.
 *
 * @returns false when there is no session to keep it in
 */
export function rememberPendingOidc(
  session: SessionLike,
  record: PendingOidcRecord,
  now: number = Date.now()
): boolean {
  if (!session || typeof session !== 'object') return false;
  const kept = Object.values(pendingOf(session))
    .filter((existing) => isLive(existing, now) && existing.state !== record.state)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-(OIDC_MAX_PENDING - 1));
  const next: Record<string, PendingOidcRecord> = {};
  for (const existing of [...kept, record]) next[existing.state] = existing;
  session[OIDC_PENDING_SESSION_KEY] = next;
  return true;
}

/** The live record for `state`, removed from `session` whether or not it is still live. */
export function takePendingOidc(
  session: SessionLike,
  state: unknown,
  now: number = Date.now()
): PendingOidcRecord | undefined {
  if (!session || typeof session !== 'object' || typeof state !== 'string' || !state) return undefined;
  const pending = pendingOf(session);
  if (!Object.prototype.hasOwnProperty.call(pending, state)) return undefined;
  const record = pending[state];
  const rest = { ...pending };
  delete rest[state];
  if (Object.keys(rest).length) {
    session[OIDC_PENDING_SESSION_KEY] = rest;
  } else {
    delete session[OIDC_PENDING_SESSION_KEY];
  }
  return isLive(record, now) ? record : undefined;
}
