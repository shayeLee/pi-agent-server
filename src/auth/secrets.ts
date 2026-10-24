// Password hashing and random credentials (docs/login-design.md §5–§6).
// Passwords: async scrypt N=2^15, r=8, p=1, 16-byte salt, 32-byte key. Node's default maxmem is too
// small for these parameters, so it is set explicitly. Cookies and personal tokens are 32 random
// bytes; only their SHA-256 is stored.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../shared/auth.js";

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SCRYPT_PREFIX = "scrypt";

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };
export const API_TOKEN_PREFIX = "pi_";

/** Length is counted in Unicode code points, so a password of emoji is not penalised. */
export function passwordLengthOk(password: string): boolean {
  const length = [...password].length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

function deriveKey(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, SCRYPT_KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** `scrypt$N$r$p$<salt base64url>$<key base64url>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [SCRYPT_PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

type ParsedHash = { n: number; r: number; p: number; salt: Buffer; key: Buffer };

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  // Only the parameters this server writes are accepted, so a tampered row cannot ask for huge work.
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return null;
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length !== SCRYPT_SALT_BYTES || key.length !== SCRYPT_KEY_LENGTH) return null;
  return { n, r, p, salt, key };
}

// A fixed hash to verify against when there is no real one, so every failure costs the same.
const DUMMY_SALT = Buffer.alloc(SCRYPT_SALT_BYTES, 7);

/**
 * Checks a password against a stored hash. With no hash (unknown account, no password method,
 * unreadable row) it still runs one scrypt of the same cost and returns false.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = stored === null ? null : parseHash(stored);
  if (parsed === null) {
    await deriveKey(password, DUMMY_SALT, SCRYPT_N, SCRYPT_R, SCRYPT_P);
    return false;
  }
  const key = await deriveKey(password, parsed.salt, parsed.n, parsed.r, parsed.p);
  return timingSafeEqual(key, parsed.key);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Browser session cookie value: 32 random bytes, base64url. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Personal token: `pi_` + 32 random bytes, base64url. */
export function newApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The first 8 characters of a personal token, shown in lists to tell tokens apart. */
export function apiTokenPrefix(token: string): string {
  return token.slice(0, 8);
}
