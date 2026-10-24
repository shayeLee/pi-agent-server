#!/usr/bin/env node
// `pnpm accounts -- <command>`: account administration (docs/login-design.md §7).
// Uses the same storage settings as the service (DB_PATH / DATA_DIR / PI_AGENT_DIR / AGENT_CWD,
// PI_STORAGE_DIALECT / PI_DATABASE_URL). The database must already be migrated to the current head;
// this command never creates or migrates tables.

import { existsSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { AccountsUsageError, parseAccountsArgs, runAccountsCommand } from "../src/accounts-cli/accounts-cli.js";
import { AuthService } from "../src/auth/auth-service.js";
import { initializeDatabaseVerifyOnly } from "../src/storage/bootstrap.js";
import { createPostgresPool, initializePostgresDatabaseVerifyOnly } from "../src/storage/postgres-bootstrap.js";
import { KyselyAccountRepository } from "../src/storage/kysely-account-repository.js";
import { resolveStorageConfig, resolveStoragePaths, type StorageEnvironment } from "../src/storage/storage-config.js";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../src/storage/db-schema.js";
import { redactedMessage } from "./migrate.js";

/** Reads one line from the terminal without echo. */
async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          done();
          resolve(value);
          return;
        }
        if (char === "\u0003") { // Ctrl-C
          done();
          reject(new AccountsUsageError("已取消"));
          return;
        }
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else value += char;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await promptHidden("密码：");
    const second = await promptHidden("再输入一次：");
    if (first !== second) throw new AccountsUsageError("两次输入的密码不一致");
    return first;
  }
  // Piped stdin: the whole input, one trailing newline removed.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function openStore(environment: StorageEnvironment): Promise<{ kysely: Kysely<DatabaseSchema>; dialect: "sqlite" | "postgres" }> {
  const { dbPath } = resolveStoragePaths({}, environment, process.cwd());
  const storage = resolveStorageConfig({}, dbPath, environment);
  if (storage.dialect === "postgres") {
    const pool = createPostgresPool(storage.databaseUrl, { connectionTimeoutMillis: 5_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
    return { kysely: await initializePostgresDatabaseVerifyOnly(pool), dialect: "postgres" };
  }
  // Opening a missing file would create an empty database; refuse instead.
  if (!existsSync(storage.dbPath)) throw new Error(`数据库不存在：${storage.dbPath}（先用 pnpm migrate 建好并迁移到最新版本）`);
  const db = new DatabaseSync(storage.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
  return { kysely: await initializeDatabaseVerifyOnly(db), dialect: "sqlite" };
}

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseAccountsArgs(argv);
  const { kysely, dialect } = await openStore(process.env);
  try {
    const auth = new AuthService(new KyselyAccountRepository(kysely, dialect));
    for (const line of await runAccountsCommand(parsed, auth, readPassword)) process.stdout.write(`${line}\n`);
  } finally {
    await kysely.destroy();
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof AccountsUsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`[accounts] ${redactedMessage(error, process.env.PI_DATABASE_URL?.trim())}\n`);
    process.exitCode = 1;
  });
}
