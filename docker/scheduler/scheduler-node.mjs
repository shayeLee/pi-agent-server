#!/usr/bin/env node
// Isolated drill scheduler. Requests explicitly select either the continuously
// running watcher or the real cron process. Cron requests are never consumed by
// the watcher, so a result tagged "cron" proves the timer process ran the CLI.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const SCHED_DIR = process.env.DRILL_SCHEDULER_DIR || "/scheduler";
const CLI_ROOT = process.env.DRILL_CLI_ROOT || "/app";

function nowIso() { return new Date().toISOString(); }

function runCli(request) {
  const backup = request.cli?.backup || path.join(CLI_ROOT, "dist-backup", "scripts", "backup.js");
  const requested = request.env || {};
  const prepend = typeof requested.DRILL_PREPEND_PATH === "string" ? requested.DRILL_PREPEND_PATH : "";
  const env = { ...process.env, ...requested };
  delete env.DRILL_PREPEND_PATH;
  if (prepend) env.PATH = `${prepend}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [backup, ...(request.argv || [])], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => resolve({ exitCode: -1, stdout: "", stderr: "scheduler child failed", doneAt: nowIso() }));
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr, doneAt: nowIso() }));
  });
}

function pending(trigger) {
  if (!existsSync(SCHED_DIR)) return [];
  const found = [];
  for (const entry of readdirSync(SCHED_DIR).sort()) {
    if (!entry.startsWith("req-")) continue;
    const dir = path.join(SCHED_DIR, entry);
    const file = path.join(dir, "request.json");
    if (!existsSync(file)) continue;
    try {
      const request = JSON.parse(readFileSync(file, "utf8"));
      if ((request.trigger || "watch") === trigger) found.push({ dir, file, request });
    } catch {
      // The host will time out and fail closed; never emit raw parse diagnostics.
    }
  }
  return found;
}

async function processOne(candidate, trigger) {
  const inflight = path.join(candidate.dir, "request.inflight.json");
  try { renameSync(candidate.file, inflight); } catch { return false; }
  const triggerAt = nowIso();
  const result = await runCli(candidate.request);
  result.trigger = trigger;
  result.triggerAt = triggerAt;
  writeFileSync(path.join(candidate.dir, "result.json"), JSON.stringify(result), { mode: 0o600 });
  renameSync(inflight, path.join(candidate.dir, "request.done.json"));
  return true;
}

async function watchLoop() {
  mkdirSync(SCHED_DIR, { recursive: true });
  while (true) {
    const candidates = pending("watch");
    if (candidates.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    await processOne(candidates[0], "watch");
  }
}

async function cronMode() {
  mkdirSync(SCHED_DIR, { recursive: true });
  const firedAt = nowIso();
  writeFileSync(path.join(SCHED_DIR, "cron.log"), `${firedAt} cron fired\n`, { flag: "a", mode: 0o600 });
  for (const candidate of pending("cron")) await processOne(candidate, "cron");
}

if (process.argv[2] === "--cron") await cronMode();
else await watchLoop();
