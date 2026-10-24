// Browser storage that belongs to one person (navigation hints, companion persona, panel picks) is
// keyed by the signed-in account, so another account in the same browser never reads it.
// In ip mode there is no account and keys stay as they were.

let storageAccountId: string | null = null;

/** Set before the app for that account mounts; `null` when nobody is signed in or in ip mode. */
export function setStorageAccount(accountId: string | null): void {
  storageAccountId = accountId;
}

export function accountScopedKey(key: string): string {
  return storageAccountId === null ? key : `${key}:account:${storageAccountId}`;
}
