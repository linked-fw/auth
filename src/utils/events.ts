import { EventEmitter } from 'events';

const authEvents = new EventEmitter();

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
 * Returns an unsubscribe function so callers don't have to keep the exact
 * callback reference around just to unregister it later (previously the
 * cause of leaked anonymous listeners across HMR reloads). `offAccountWillBeRemoved`
 * is still available for callers that already store the callback themselves.
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
export async function emitAccountWillBeRemovedEvent(account) {
  const listeners = authEvents.listeners(ACCOUNT_REMOVED_EVENT);
  await Promise.all(
    listeners.map((listener) => Promise.resolve(listener(account)))
  );
}
