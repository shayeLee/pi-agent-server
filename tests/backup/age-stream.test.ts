import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ageAdapter, createSqliteBackup, spawnAgeFile, type AgeAdapter } from "../../src/backup/backup-core.js";
import { createCanonicalSqliteBaseline } from "./sqlite-fixture.js";

// ---------------------------------------------------------------------------
// Deterministic fake child: replays stream/child event orderings that are only
// racy with the real age binary (notably child `close` winning over the output
// stream's `finish` — the WP3C full-gate timeout root cause).
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
};

function fakeSpawn(script: (child: FakeChild) => void): { spawnImpl: typeof spawn; killCount: () => number } {
  let killed = 0;
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    expect(_command).toBe("age");
    expect(args[0]).toBe("--encrypt");
    const child = new EventEmitter() as unknown as FakeChild;
    child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    child.stdout = new Readable({ read() { /* pushed by the script */ } });
    child.stderr = new Readable({ read() { /* silent stderr */ } });
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      killed++;
      child.signalCode = "SIGKILL";
      child.emit("close", null, "SIGKILL");
      return true;
    };
    queueMicrotask(() => script(child));
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, killCount: () => killed };
}

/**
 * Fake child whose `close` event TRAILS the `kill` by `killToCloseMs` — exactly
 * what a real age child does after SIGKILL (process reaped + stdio wound down
 * asynchronously). Replays the internal-timeout delayed-close contract.
 */
function delayedCloseSpawn(killToCloseMs: number): { spawnImpl: typeof spawn; killCount: () => number; closeAt: () => number } {
  let killed = 0;
  let closeAt = 0;
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    expect(_command).toBe("age");
    expect(args[0]).toBe("--encrypt");
    const child = new EventEmitter() as unknown as FakeChild;
    child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    child.stdout = new Readable({ read() { /* never pushed: the child never produces ciphertext */ } });
    child.stderr = new Readable({ read() { /* silent stderr */ } });
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      killed++;
      child.signalCode = "SIGKILL";
      // The close event does NOT fire synchronously: it trails the kill.
      setTimeout(() => {
        closeAt = Date.now();
        child.emit("close", null, "SIGKILL");
      }, killToCloseMs);
      return true;
    };
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, killCount: () => killed, closeAt: () => closeAt };
}

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });

/** Let pending threadpool opens/close events settle before asserting absence. */
async function flushFs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Poll until `file` is gone (or fail after a generous budget): under full
 * parallel test load a createWriteStream open can complete on the threadpool
 * well after the failure path's removal sweep, so a single fixed flush is
 * not enough to assert absence deterministically.
 */
async function waitGone(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(existsSync(file)).toBe(false);
}

function stage(): { root: string; input: string; output: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pi-age-stream-"));
  cleanups.push(root);
  const input = path.join(root, "plain.bin");
  const output = path.join(root, `out.age-${randomUUID()}`);
  writeFileSync(input, Buffer.alloc(256 * 1024, 7), { mode: 0o600 });
  return { root, input, output };
}

describe("spawnAgeFile stream/child lifecycle", () => {
  it("resolves when child close wins the race against output finish (WP3C full-gate regression)", async () => {
    const { input, output } = stage();
    const cipher = Buffer.from("FAKE-CIPHERTEXT-close-before-finish");
    const { spawnImpl } = fakeSpawn((child) => {
      // All ciphertext is queued into the output write stream (disk flush still
      // pending) and the child exits BEFORE the output stream can emit finish.
      child.stdout.push(cipher);
      child.stdout.push(null);
      child.emit("close", 0, null);
    });
    // The previous finish→close nesting missed the close event that already
    // fired and then hung until the safety budget rejected a successful run.
    await spawnAgeFile(["--encrypt", "--recipients-file", "r"], input, output, 60_000, spawnImpl);
    expect(readFileSync(output)).toEqual(cipher);
  });

  it("resolves only after both output finish and a delayed child close", async () => {
    const { input, output } = stage();
    const cipher = Buffer.from("FAKE-CIPHERTEXT-delayed-close");
    const { spawnImpl } = fakeSpawn((child) => {
      child.stdout.push(cipher);
      child.stdout.push(null);
      setTimeout(() => { child.exitCode = 0; child.emit("close", 0, null); }, 80);
    });
    const started = Date.now();
    await spawnAgeFile(["--encrypt", "--recipients-file", "r"], input, output, 60_000, spawnImpl);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(readFileSync(output)).toEqual(cipher);
  });

  it("rejects exactly once on non-zero exit, removes the output and kills the child", async () => {
    const { input, output } = stage();
    const { spawnImpl, killCount } = fakeSpawn((child) => {
      child.stdout.push(Buffer.from("partial ciphertext"));
      child.stdout.push(null);
      child.exitCode = 1;
      child.emit("close", 1, null);
    });
    await expect(spawnAgeFile(["--encrypt", "--recipients-file", "missing-recipient"], input, output, 60_000, spawnImpl))
      .rejects.toThrow(/age encryption failed/);
    await waitGone(output);
    // The child already exited (code 1); no kill was needed.
    expect(killCount()).toBe(0);
  });

  it("aborts a hung child on timeout: single rejection, kill, no output or handle leak", async () => {
    const { input, output } = stage();
    const { spawnImpl, killCount } = fakeSpawn(() => { /* child never produces output and never exits */ });
    await expect(spawnAgeFile(["--encrypt", "--recipients-file", "r"], input, output, 150, spawnImpl))
      .rejects.toThrow(/age encryption exceeded the 150ms safety budget/);
    await waitGone(output);
    expect(killCount()).toBe(1);
  });

  it("delayed close: the timeout rejection waits for the killed child's confirmed close (P1)", async () => {
    const { input, output } = stage();
    const { spawnImpl, killCount, closeAt } = delayedCloseSpawn(150);
    const started = Date.now();
    await expect(spawnAgeFile(["--encrypt", "--recipients-file", "r"], input, output, 50, spawnImpl))
      .rejects.toThrow(/age encryption exceeded the 50ms safety budget/);
    // The rejection may only surface AFTER the child's close was confirmed:
    // never while the killed child (or its streams) may still be winding down.
    expect(closeAt()).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(closeAt() - started);
    expect(killCount()).toBe(1);
    await waitGone(output);
  });

  it("fails closed on an input read error without leaving the output behind", async () => {
    const { root, input, output } = stage();
    const { spawnImpl } = fakeSpawn(() => { /* child idles; the plaintext never opens */ });
    rmSync(input, { force: true }); // ENOENT at createReadStream open time
    await expect(spawnAgeFile(["--encrypt", "--recipients-file", "r"], input, output, 60_000, spawnImpl))
      .rejects.toThrow(/age input read failed/);
    await waitGone(output);
    expect(existsSync(root)).toBe(true);
  });

  it("rejects when the child dies before consuming stdin (EPIPE) without crashing on an unhandled error", async () => {
    const { input, output } = stage();
    const { spawnImpl } = fakeSpawn((child) => {
      // age rejects the recipient file and exits before reading the plaintext.
      child.emit("close", 1, null);
      child.stdin.destroy(new Error("write EPIPE"));
    });
    await expect(spawnAgeFile(["--encrypt", "--recipients-file", "bad"], input, output, 60_000, spawnImpl))
      .rejects.toThrow(/age encryption failed/);
    await waitGone(output);
  });
});

// ---------------------------------------------------------------------------
// Real age binary: parallel/repeated streaming encryption and throughput-based
// budget sizing. These need only the `age`/`age-keygen` binaries (no PG).
// ---------------------------------------------------------------------------

const canRunAge = spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("age-keygen", ["-h"], { stdio: "ignore" }).status === 0;
const describeRealAge = canRunAge ? describe : describe.skip;

function ageFixture(): { root: string; recipient: string; identity: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pi-age-real-"));
  cleanups.push(root);
  const identity = path.join(root, "identity");
  const recipient = path.join(root, "recipient");
  const generated = spawnSync("age-keygen", ["--output", identity], { stdio: "ignore" });
  if (generated.status !== 0) throw new Error("age-keygen unavailable");
  const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" }).stdout.trim();
  writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });
  return { root, recipient, identity };
}

function decrypt(identity: string, file: string): Buffer {
  const result = spawnSync("age", ["--decrypt", "--identity", identity, file], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`age decrypt failed: ${result.stderr.toString()}`);
  return result.stdout;
}

describeRealAge("real age streaming encryption", () => {
  it("encrypts repeatedly and in parallel without cross-stream interference", async () => {
    const { root, recipient, identity } = ageFixture();
    const payloads = Array.from({ length: 8 }, (_, index) => ({
      input: path.join(root, `plain-${index}.bin`),
      output: path.join(root, `out-${index}.age`),
      bytes: Buffer.concat([Buffer.from(randomUUID()), Buffer.alloc(1024 * 1024, index)]),
    }));
    for (const payload of payloads) writeFileSync(payload.input, payload.bytes, { mode: 0o600 });
    // Full parallel burst: every stdin/stdout/stdio pair must stay independent.
    await Promise.all(payloads.map((payload) => ageAdapter.encryptFile!(payload.input, payload.output, recipient)));
    for (const payload of payloads) {
      const decrypted = decrypt(identity, payload.output);
      expect(createHash("sha256").update(decrypted).digest("hex")).toBe(createHash("sha256").update(payload.bytes).digest("hex"));
    }
  });

  it("sizes the default budget from measured throughput (documented sizing evidence)", async () => {
    const { root, recipient, identity } = ageFixture();
    // 64 MiB is orders of magnitude above real prebackup payloads (KB–MB);
    // if even this completes in seconds, the 60s default budget bounds child
    // scheduling, not payload time.
    const input = path.join(root, "plain-64mib.bin");
    const output = path.join(root, "out-64mib.age");
    writeFileSync(input, Buffer.alloc(64 * 1024 * 1024, 11), { mode: 0o600 });
    const started = Date.now();
    await ageAdapter.encryptFile!(input, output, recipient);
    const elapsed = Date.now() - started;
    const mibPerSecond = Math.round(64 / Math.max(elapsed, 1) * 1000);
    console.log(`[age-stream] measured real age throughput: ${mibPerSecond} MiB/s (64 MiB in ${elapsed}ms)`);
    expect(elapsed).toBeLessThan(15_000);
    expect(createHash("sha256").update(decrypt(identity, output)).digest("hex"))
      .toBe(createHash("sha256").update(readFileSync(input)).digest("hex"));
  });
});

describe("backup staging leak regression", () => {
  it("clears staging when the age stream hangs past its budget and never publishes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-age-leak-"));
    cleanups.push(root);
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dataDir, "sessions", "s1", "history.jsonl"), '{"ok":true}\n', { mode: 0o600 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    createCanonicalSqliteBaseline(db);
    db.close();
    const recipient = path.join(root, "recipient.txt");
    writeFileSync(recipient, "age1testrecipient\n", { mode: 0o600 });
    const age: AgeAdapter = {
      encrypt(input) { return input; },
      encryptFile: () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("age encryption exceeded the 25ms test budget")), 25);
      }),
    };
    await expect(createSqliteBackup({
      paths: { dataDir, dbPath, backupRoot, ageRecipientFile: recipient },
      age,
    })).rejects.toThrow(/25ms test budget/);
    // No staging directory, no tmp ciphertext, no COMPLETE marker may survive.
    expect(readdirSync(root).filter((name) => name.startsWith(".pi-agent-backup-staging-"))).toEqual([]);
    expect(readdirSync(backupRoot)).toEqual([]);
    expect(existsSync(path.join(backupRoot, "COMPLETE"))).toBe(false);
  });
});
