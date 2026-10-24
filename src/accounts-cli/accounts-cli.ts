// `pnpm accounts -- <command>`: account administration for accounts mode (docs/login-design.md §7).
// Safe to run while the service is running; the service applies changes on the next request.
// Passwords are read from an interactive prompt or stdin, never from arguments.

import { AuthError, type AuthService } from "../auth/auth-service.js";

export const ACCOUNTS_USAGE = `用法：pnpm accounts -- <命令> [参数]

  create --name <名> --role <admin|user|viewer|operator>   新建账号（交互或 stdin 输入密码）
  set-password --name <名>                                  重设密码，并清掉该账号所有登录状态
  set-role --name <名> --role <角色>                         改角色
  disable --name <名>                                       禁用，清掉登录状态并吊销全部 token
  enable --name <名>                                        重新启用（token 仍是吊销状态）
  list                                                      列出账号
  sessions --name <名>                                      列出已登录设备
  kick --session <id>                                       踢掉一台设备
  issue-token --name <名> --label <用途>                     签发个人 token（明文只显示这一次）
  tokens --name <名>                                        列出个人 token
  revoke-token --id <id>                                    吊销个人 token`;

type CommandSpec = { readonly required: readonly string[]; readonly password?: boolean };

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  create: { required: ["name", "role"], password: true },
  "set-password": { required: ["name"], password: true },
  "set-role": { required: ["name", "role"] },
  disable: { required: ["name"] },
  enable: { required: ["name"] },
  list: { required: [] },
  sessions: { required: ["name"] },
  kick: { required: ["session"] },
  "issue-token": { required: ["name", "label"] },
  tokens: { required: ["name"] },
  "revoke-token": { required: ["id"] },
};

export type AccountsCommand = { readonly command: string; readonly options: Readonly<Record<string, string>>; readonly needsPassword: boolean };

export class AccountsUsageError extends Error {}

export function parseAccountsArgs(argv: readonly string[]): AccountsCommand {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") throw new AccountsUsageError(ACCOUNTS_USAGE);
  const spec = COMMANDS[command];
  if (!spec) throw new AccountsUsageError(`未知命令：${command}\n\n${ACCOUNTS_USAGE}`);
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    const key = flag.startsWith("--") ? flag.slice(2) : "";
    if (!spec.required.includes(key)) throw new AccountsUsageError(`${command} 不接受参数 ${flag}\n\n${ACCOUNTS_USAGE}`);
    if (value === undefined || value.startsWith("--")) throw new AccountsUsageError(`${flag} 需要一个值`);
    if (Object.hasOwn(options, key)) throw new AccountsUsageError(`${flag} 重复`);
    options[key] = value;
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(options, key)) throw new AccountsUsageError(`${command} 需要 --${key}\n\n${ACCOUNTS_USAGE}`);
  }
  return { command, options, needsPassword: spec.password === true };
}

function time(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/** Runs one command and returns the lines to print. */
export async function runAccountsCommand(
  parsed: AccountsCommand,
  auth: AuthService,
  readPassword: () => Promise<string>,
): Promise<string[]> {
  const o = parsed.options;
  try {
    switch (parsed.command) {
      case "create": {
        const account = await auth.createAccount(o.name!, o.role!, await readPassword());
        return [`已创建账号 ${account.name}（${account.role}），id ${account.id}`];
      }
      case "set-password":
        await auth.setPassword(o.name!, await readPassword());
        return [`已重设 ${o.name} 的密码，该账号的浏览器都需要重新登录`];
      case "set-role":
        await auth.setRole(o.name!, o.role!);
        return [`已把 ${o.name} 改为 ${o.role}；下一个请求起生效，已连着的事件流 30 秒内断开`];
      case "disable":
        await auth.disable(o.name!);
        return [`已禁用 ${o.name}：登录状态已清掉，token 已全部吊销；在跑的任务不会被中止`];
      case "enable":
        await auth.enable(o.name!);
        return [`已启用 ${o.name}；之前吊销的 token 不会恢复，需要时重新签发`];
      case "list": {
        const accounts = await auth.listAccounts();
        if (accounts.length === 0) return ["还没有账号"];
        return accounts.map(a => `${a.name}\t${a.role}\t${a.disabled ? "已禁用" : "正常"}\t${a.id}`);
      }
      case "sessions": {
        const sessions = await auth.listSessions(o.name!);
        if (sessions.length === 0) return ["没有已登录的设备"];
        return sessions.map(s => `${s.id}\t登录 ${time(s.createdAt)}\t最近 ${time(s.lastSeenAt)}\t到期 ${time(s.expiresAt)}\t${s.label ?? ""}`);
      }
      case "kick":
        await auth.kick(o.session!);
        return ["已踢掉该设备"];
      case "issue-token": {
        const { token, record } = await auth.issueToken(o.name!, o.label!);
        return [
          `已签发 token ${record.id}（${record.name}）。明文只显示这一次，请立即保存：`,
          token,
        ];
      }
      case "tokens": {
        const tokens = await auth.listTokens(o.name!);
        if (tokens.length === 0) return ["没有个人 token"];
        return tokens.map(t => `${t.id}\t${t.prefix}…\t${t.name}\t创建 ${time(t.createdAt)}\t最近 ${time(t.lastUsedAt)}\t${t.revokedAt === null ? "有效" : `已吊销 ${time(t.revokedAt)}`}`);
      }
      case "revoke-token":
        await auth.revokeToken(o.id!);
        return ["已吊销该 token"];
      default:
        throw new AccountsUsageError(ACCOUNTS_USAGE);
    }
  } catch (error) {
    if (error instanceof AuthError) throw new AccountsUsageError(error.message);
    throw error;
  }
}
