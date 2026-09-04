import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ageBinary = "age";
const ageKeygenBinary = "age-keygen";
const runQuietly = (command, args, options = {}) => spawnSync(command, args, {
  ...options,
  stdio: options.stdio ?? "ignore",
});

const missingBinaries = [
  runQuietly(ageBinary, ["--version"]).status !== 0 ? ageBinary : null,
  runQuietly(ageKeygenBinary, ["-h"]).status !== 0 ? ageKeygenBinary : null,
].filter((binary) => binary !== null);

let directory;
try {
  if (missingBinaries.length > 0) {
    throw new Error(`required binary unavailable: ${missingBinaries.join(" and ")}; install age (including age-keygen)`);
  }

  directory = mkdtempSync(path.join(tmpdir(), "pi-age-test-"));
  const identityPath = path.join(directory, "identity");
  const plaintextPath = path.join(directory, "plain");
  const encryptedPath = path.join(directory, "plain.age");
  const decryptedPath = path.join(directory, "decrypted");
  const bytes = Buffer.from("real age integration payload\n", "utf8");

  const keygenRun = runQuietly(ageKeygenBinary, ["--output", identityPath]);
  if (keygenRun.status !== 0 || !existsSync(identityPath)) {
    throw new Error("one-time age identity generation failed");
  }

  const recipientRun = runQuietly(ageKeygenBinary, ["-y", identityPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const recipient = recipientRun.stdout?.trim();
  if (recipientRun.status !== 0 || !/^age1[0-9a-z]+$/.test(recipient ?? "")) {
    throw new Error("one-time age recipient extraction failed");
  }

  writeFileSync(plaintextPath, bytes, { mode: 0o600 });
  const encryptedRun = runQuietly(ageBinary, [
    "--encrypt",
    "--recipients-file",
    "-",
    "--output",
    encryptedPath,
    plaintextPath,
  ], { input: `${recipient}\n`, stdio: ["pipe", "ignore", "ignore"] });
  if (encryptedRun.status !== 0 || !existsSync(encryptedPath)) {
    throw new Error("encryption failed");
  }

  const decryptRun = runQuietly(ageBinary, [
    "--decrypt",
    "--identity",
    identityPath,
    "--output",
    decryptedPath,
    encryptedPath,
  ]);
  if (decryptRun.status !== 0 || !existsSync(decryptedPath)) {
    throw new Error("decryption failed");
  }

  const decrypted = readFileSync(decryptedPath);
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  const actualHash = createHash("sha256").update(decrypted).digest("hex");
  if (!decrypted.equals(bytes) || actualHash !== expectedHash) {
    throw new Error("decrypted content/hash mismatch");
  }

  console.log("age integration test: real encryption/decryption/hash ok");
} catch (error) {
  console.error(`age integration gate failed: ${error instanceof Error ? error.message : "verification failed"}`);
  process.exitCode = 1;
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
