// Test accounts for the accounts-mode E2E group. The mock server (scripts/mock-server.ts) creates
// them from MOCK_ACCOUNTS; the specs sign in with the same values. Test-only passwords.

export const ACCOUNTS = {
  mz: { name: "mz", role: "admin", password: "mz-e2e-password-1" },
  ada: { name: "ada", role: "user", password: "ada-e2e-password-1" },
  kim: { name: "kim", role: "user", password: "kim-e2e-password-1" },
} as const;

/** `name:role:password,…` for the mock server. */
export function accountsEnv(): string {
  return Object.values(ACCOUNTS).map(account => `${account.name}:${account.role}:${account.password}`).join(",");
}
