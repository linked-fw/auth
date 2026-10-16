/**
 * Solid-OIDC sign-in in a native app (Capacitor), on the client (RFC 8252; arch-08 §Protocol,
 * "Native apps", in the Create Now repo). No React.
 *
 * 1. `startNativeOidcSignin` asks the server for the issuer's authorization URL and the pending
 *    sign-in, sealed by the server, and keeps that record on the device with the token storage the
 *    app registered (`setAuthTokenStorageMethods`). The system browser shares no cookie with the
 *    app, so the server keeps nothing between the two steps.
 * 2. It opens the URL with the app's system browser (`setOidcSigninBrowser`): never a WebView, so
 *    the issuer's page and its cookies stay out of the app.
 * 3. The issuer sends the user to the app-claimed link (Universal Link, App Link or custom scheme).
 *    The app hands that URL to `completeOidcSignin`, which finishes the exchange on the server and
 *    stores the session's tokens. When the browser itself resolves to the URL
 *    (`ASWebAuthenticationSession`), step 1 does this at once.
 */
import { Server } from '@_linked/server-utils/utils/Server';
import { packageName } from '../package.js';
import {
  getAuthToken,
  isNativeTokenStorage,
  removeAuthToken,
  setAuthToken,
  storeAuthTokens,
} from './token.js';
import type { NativeOidcSigninAnswer, NativeOidcStartAnswer } from '../types/auth.js';

/**
 * Opens `url` in the system browser: `ASWebAuthenticationSession` on iOS, Custom Tabs on Android,
 * through the app's Capacitor plugin. Resolve to the URL the issuer returned to when the plugin
 * hands it back (an authentication session does), or to nothing when the link reaches the app
 * through its `appUrlOpen` listener instead, which then calls `completeOidcSignin`. Reject when
 * the user cancels.
 */
export type OidcSigninBrowser = (
  url: string,
  options: { redirectUri: string }
) => Promise<string | void | undefined>;

/** The storage key of the pending sign-in on the device. */
export const OIDC_PENDING_STORAGE_KEY = 'oidcPending';

/** How long the device keeps a pending sign-in, in seconds; the server refuses it after that. */
const OIDC_PENDING_STORAGE_SECONDS = 10 * 60;

let openSystemBrowser: OidcSigninBrowser | undefined;

/** Register how this app opens the system browser for a sign-in (see `OidcSigninBrowser`). */
export function setOidcSigninBrowser(open: OidcSigninBrowser | undefined): void {
  openSystemBrowser = open;
}

/** What `startNativeOidcSignin` answers while the user is still at the issuer. */
export type NativeOidcSigninWaiting = { waiting: true; state: string };

/** A sign-in that could not start or complete; `action` says which way. */
export type NativeOidcSigninError = Extract<NativeOidcSigninAnswer, { error: string }>;

type StoredPending = { state: string; pending: string };

const failure = (action: string, error: string): NativeOidcSigninError => ({ error, action });

async function readPending(): Promise<StoredPending | undefined> {
  try {
    const raw = await getAuthToken(OIDC_PENDING_STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) : undefined;
    return stored && typeof stored.state === 'string' && typeof stored.pending === 'string'
      ? stored
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start a sign-in through the user's Solid-OIDC issuer from a native app.
 *
 * Needs the app's token storage (`setAuthTokenStorageMethods`) and system browser
 * (`setOidcSigninBrowser`). A new sign-in replaces one still pending on the device.
 *
 * @param options.input - An email or a WebID; may be left out with a `providerHint` (the sign-in
 *   starts at the default issuer, the provider decides the email)
 * @param options.redirectUri - The app-claimed link the issuer returns to; one of the Client ID
 *   Document's `redirect_uris` (`Auth.signinClient.redirectUris` on the server)
 * @returns the completed sign-in when the browser resolved to the callback URL (see
 *   `completeOidcSignin`), `{waiting: true, state}` when the link will arrive through the app's URL
 *   listener, or `{error, action}`: `not_native`, `no_browser`, `browser_failed` (also when the user
 *   cancelled), or the server's start errors
 */
export async function startNativeOidcSignin(options: {
  input?: string;
  redirectUri: string;
  prompt?: 'none';
  providerHint?: string;
}): Promise<NativeOidcSigninAnswer | NativeOidcSigninWaiting> {
  if (!isNativeTokenStorage()) {
    return failure('not_native', 'Register the token storage first (setAuthTokenStorageMethods)');
  }
  const open = openSystemBrowser;
  if (!open) return failure('no_browser', 'Register the system browser first (setOidcSigninBrowser)');

  const started: NativeOidcStartAnswer | undefined = await Server.call(
    packageName,
    'startNativeOidcSignin',
    options
  );
  if (!started) return failure('failed', 'The sign-in could not start');
  if (!('url' in started)) {
    return {
      error: started.error || 'The sign-in could not start',
      action: started.action || 'failed',
      ...(started.retryAfter ? { retryAfter: started.retryAfter } : {}),
    };
  }

  const stored: StoredPending = { state: started.state, pending: started.pending };
  await setAuthToken({
    key: OIDC_PENDING_STORAGE_KEY,
    value: JSON.stringify(stored),
    expires: OIDC_PENDING_STORAGE_SECONDS,
  });

  let returned: string | void | undefined;
  try {
    returned = await open(started.url, { redirectUri: options.redirectUri });
  } catch (error) {
    // only this sign-in's record: a newer start may have replaced it meanwhile
    if ((await readPending())?.state === started.state) {
      await removeAuthToken(OIDC_PENDING_STORAGE_KEY);
    }
    return failure('browser_failed', (error as Error)?.message || 'The sign-in was cancelled');
  }
  if (typeof returned === 'string' && returned) return completeOidcSignin(returned);
  return { waiting: true, state: started.state };
}

/**
 * Finish a native sign-in with the URL the issuer sent the user back to (the app-claimed link, as
 * the app's `appUrlOpen` listener or the browser plugin received it). The `state` in the URL must
 * be the one of the sign-in pending on this device: a link for any other sign-in is refused here,
 * without a call, and leaves the pending one in place. The pending record is used once. On success
 * the session's tokens are stored with the app's token storage.
 *
 * @returns the server's answer: `{auth, accessToken, refreshToken, …, outcome}`, or
 *   `{error, action, outcome?}` (`invalid_state`, `login_required`, `email_mismatch`, …)
 */
export async function completeOidcSignin(callbackUrl: string): Promise<NativeOidcSigninAnswer> {
  let state: string | null;
  try {
    state = new URL(callbackUrl).searchParams.get('state');
  } catch {
    state = null;
  }
  const stored = await readPending();
  if (!state || !stored || stored.state !== state) {
    return {
      ...failure('invalid_state', 'This sign-in link is not for a sign-in started on this device'),
      outcome: { ok: false, error: 'invalid_state' },
    };
  }
  await removeAuthToken(OIDC_PENDING_STORAGE_KEY);

  let answer: NativeOidcSigninAnswer | undefined;
  try {
    answer = await Server.call(packageName, 'completeNativeOidcSignin', {
      callbackUrl,
      pending: stored.pending,
    });
  } catch (error) {
    // the record was used: the user starts again
    return failure('failed', (error as Error)?.message || 'The sign-in did not complete');
  }
  if (!answer) return failure('failed', 'The sign-in did not complete');
  if ('auth' in answer && answer.auth) {
    await storeAuthTokens({
      accessToken: answer.accessToken,
      refreshToken: answer.refreshToken,
      refreshTokenExpiresIn: answer.refreshTokenExpiresIn,
      refreshTokenExpiresAt: answer.refreshTokenExpiresAt,
    });
  }
  return answer;
}
