import { EventEmitter } from 'events';
import { sharedState } from '@_linked/core/utils/sharedState';

/**
 * The auth event bus, shared by every copy of this module in the runtime: a listener added
 * through one copy hears an event emitted through another (account-removal cleanup). See
 * https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md.
 */
const { authEvents } = sharedState('@_linked/auth', 'events', () => ({
  authEvents: new EventEmitter(),
}));

const NEW_USER_EVENT = '@_linked/auth/new-user';
const ACCOUNT_REMOVED_EVENT = '@_linked/auth/account-removed';

export function emitNewUserEvent(person, account) {
  return new Promise<void>((resolve) => {
    authEvents.emit(NEW_USER_EVENT, person, account);
    resolve();
  });
}

export function onNewUser<PersonType, AccountType>(
  callback: (person: PersonType, account: AccountType) => void
) {
  authEvents.on(NEW_USER_EVENT, callback);
}

export function offNewUser<PersonType, AccountType>(
  callback: (person: PersonType, account: AccountType) => void
) {
  authEvents.off(NEW_USER_EVENT, callback);
}

/**
 * Run `callback` before an account is removed. An async callback is awaited: the account is
 * only deleted once every listener has finished.
 *
 * @returns a function that removes the listener again
 */
export function onAccountWillBeRemoved<AccountType>(
  callback: (account: AccountType) => void | Promise<void>
): () => void {
  authEvents.on(ACCOUNT_REMOVED_EVENT, callback);
  return () => authEvents.off(ACCOUNT_REMOVED_EVENT, callback);
}

export function offAccountWillBeRemoved<AccountType>(
  callback: (account: AccountType) => void | Promise<void>
) {
  authEvents.off(ACCOUNT_REMOVED_EVENT, callback);
}

/**
 * Call every account-removed listener and wait for all of them. Every listener runs even when
 * one fails; the first failure is then thrown, so the removal stops before anything is deleted.
 */
export async function emitAccountWillBeRemovedEvent(account) {
  const listeners = authEvents.listeners(ACCOUNT_REMOVED_EVENT);
  const results = await Promise.allSettled(
    listeners.map(async (listener) => listener(account))
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failed) throw failed.reason;
}
