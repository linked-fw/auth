/**
 * Pending Solid-OIDC sign-ins of native apps, held on the device. A native app opens the issuer in
 * the system browser, which shares no cookie with the app, so the server cannot keep the record in
 * a session. It seals the record instead (AES-256-GCM, a key derived from the JWT secret for this
 * use only) and the app stores the opaque string until the issuer sends the user back. Opening it
 * checks that nobody changed it (the issuer the server will contact, the redirect URI, the age)
 * and that it is younger than `OIDC_PENDING_TTL_MS`.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { PendingOidcSignin } from '../utils/oidcSignin.js';
import { OIDC_PENDING_TTL_MS } from './oidcPending.js';

/** Format prefix of a sealed record, so a later format can be told apart. */
const VERSION = 'v1';
const KEY_LABEL = '@_linked/auth native OIDC pending sign-in v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Longest sealed string accepted; a real record is about 1 KB. */
export const SEALED_PENDING_MAX_LENGTH = 8192;

/** A native sign-in's pending record: the redirect URI is the app-claimed link it started with. */
export type NativePendingOidc = PendingOidcSignin & { redirectUri: string };

const keyFor = (secret: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), KEY_LABEL, 32));

/** The record as an opaque string for the device to hold. */
export function sealPendingOidc(record: NativePendingOidc, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  cipher.setAAD(Buffer.from(VERSION));
  const body = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

/**
 * The record `sealed` holds, or `undefined` when it is not one this server sealed, was changed,
 * or is older than `OIDC_PENDING_TTL_MS`.
 */
export function openPendingOidc(
  sealed: unknown,
  secret: string,
  now: number = Date.now()
): NativePendingOidc | undefined {
  if (typeof sealed !== 'string' || sealed.length > SEALED_PENDING_MAX_LENGTH) return undefined;
  const [version, data, ...rest] = sealed.split('.');
  if (version !== VERSION || !data || rest.length) return undefined;
  let record: unknown;
  try {
    const raw = Buffer.from(data, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(VERSION));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const body = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]);
    record = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  const pending = record as NativePendingOidc;
  if (
    !pending ||
    typeof pending !== 'object' ||
    typeof pending.state !== 'string' ||
    typeof pending.redirectUri !== 'string' ||
    typeof pending.createdAt !== 'number'
  ) {
    return undefined;
  }
  const age = now - pending.createdAt;
  return age >= 0 && age < OIDC_PENDING_TTL_MS ? pending : undefined;
}
