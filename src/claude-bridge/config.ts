// Bridge settings, read once from the environment Claude Desktop starts the process with.
import { readFileSync } from "node:fs";

export type BridgeConfig = {
  /** pi-agent-server origin, without a trailing slash. */
  baseUrl: string;
  /** Bearer token read from PI_BRIDGE_TOKEN_FILE; empty when the backend needs none. */
  token: string;
  /** Short backend name shown in tool descriptions, such as "dev". */
  label: string;
  /** Web UI origin used to build session links; empty means no links. */
  webUrl: string;
  /** Longest a single pi_send / pi_wait call waits for a turn to finish. */
  waitMs: number;
  /** Project ids the bridge may touch; empty means every visible project. */
  projects: readonly string[];
};

const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 3600;

export class BridgeConfigError extends Error {
  override name = "BridgeConfigError";
}

export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const baseUrl = parseOrigin(env.PI_BRIDGE_BASE_URL, "PI_BRIDGE_BASE_URL", true);
  const tokenFile = env.PI_BRIDGE_TOKEN_FILE?.trim();
  let token = "";
  if (tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf8").trim();
    } catch {
      throw new BridgeConfigError(`PI_BRIDGE_TOKEN_FILE 读不了：${tokenFile}`);
    }
    if (!token) throw new BridgeConfigError(`PI_BRIDGE_TOKEN_FILE 是空文件：${tokenFile}`);
  }

  const waitRaw = env.PI_BRIDGE_WAIT_SECONDS?.trim();
  let waitSeconds = DEFAULT_WAIT_SECONDS;
  if (waitRaw) {
    waitSeconds = Number(waitRaw);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > MAX_WAIT_SECONDS) {
      throw new BridgeConfigError(`PI_BRIDGE_WAIT_SECONDS 要是 1–${MAX_WAIT_SECONDS} 的整数，现在是 ${waitRaw}`);
    }
  }

  return {
    baseUrl,
    token,
    label: env.PI_BRIDGE_LABEL?.trim() || new URL(baseUrl).host,
    webUrl: parseOrigin(env.PI_BRIDGE_WEB_URL, "PI_BRIDGE_WEB_URL", false),
    waitMs: waitSeconds * 1000,
    projects: (env.PI_BRIDGE_PROJECTS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  };
}

function parseOrigin(raw: string | undefined, name: string, required: boolean): string {
  const value = raw?.trim() ?? "";
  if (!value) {
    if (required) throw new BridgeConfigError(`缺少 ${name}，例如 http://127.0.0.1:8080`);
    return "";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BridgeConfigError(`${name} 不是合法地址：${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BridgeConfigError(`${name} 只支持 http 或 https：${value}`);
  }
  return value.replace(/\/+$/, "");
}
