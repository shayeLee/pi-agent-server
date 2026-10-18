// 用户 MCP 凭证的加密（docs/mcp-integration.md §13.8）。密钥来自 PI_MCP_TOKEN_KEY_FILE：
// 绝对路径、权限 0600 的文本文件，内容是 32 字节随机数的 base64（`openssl rand -base64 32`）。
// AES-256-GCM，附加数据绑定所在行，密文挪到别的行就解不开。错误信息从不回显密钥或明文。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readConfigFile } from "./catalog.js";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class McpTokenCipher {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("MCP token key must be 32 bytes");
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string, associatedData: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
  }

  /** 格式不对、密钥不对或附加数据不匹配时抛错（调用方按“凭证不可用”处理）。 */
  decrypt(ciphertext: string, associatedData: string): string {
    const [version, ivText, bodyText, extra] = ciphertext.split(".");
    if (version !== VERSION || !ivText || !bodyText || extra !== undefined) throw new Error("MCP token ciphertext has an unknown format");
    const iv = Buffer.from(ivText, "base64url");
    const body = Buffer.from(bodyText, "base64url");
    if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new Error("MCP token ciphertext has an unknown format");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("MCP token ciphertext cannot be decrypted with this key");
    }
  }
}

/** 读取 PI_MCP_TOKEN_KEY_FILE。 */
export function loadMcpTokenKeyFile(path: string): McpTokenCipher {
  const what = "PI_MCP_TOKEN_KEY_FILE";
  const text = readConfigFile(path, what, true).trim();
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? Buffer.from(text, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error(`${what} must contain 32 random bytes in base64 (openssl rand -base64 32)`);
  return new McpTokenCipher(key);
}
