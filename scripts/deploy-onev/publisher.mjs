#!/usr/bin/env node
/**
 * ONEV 文档站 loopback publisher（无第三方依赖，只用于内网单机）。
 *
 * POST /publish 会一直等待其对应批次构建结束：只有新 release 校验并原子切换成功才返回 200；
 * 构建或发布失败返回 500。插件因此只会在站点真正可刷新后把同步 job 标记成功。
 *
 * 构建写入 /data/onev/onev-ui-releases 下的独立 staging 目录，成功后改名为 release，
 * 再用同目录 rename 原子替换 current 软链接。nginx 始终读取 current，失败时继续服务旧 release。
 */
import http from "node:http";
import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = 9091;
const PROJECT_DIR = "/srv/onev";
const RELEASES_DIR = "/data/onev/onev-ui-releases";
const CURRENT_LINK = path.join(RELEASES_DIR, "current");
const VOLTA_BIN = "/home/onev/.volta/bin/volta";
const BUILD_ARGV = Object.freeze([
  "run", "--node", "16.20.2", "--yarn", "1.22.22", "--", "yarn", "build:docs",
]);
const DEBOUNCE_MS = 1000;
const MAX_BODY_BYTES = 64 * 1024;

let building = false;
let queued = [];
let debounceTimer = null;
let shuttingDown = false;
let inFlightRequests = 0;
let releaseSequence = 0;

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function assertReleaseRoot() {
  const root = lstatSync(RELEASES_DIR);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("release root must be a directory");
  if (root.uid !== process.getuid()) throw new Error("release root owner mismatch");
  if ((root.mode & 0o022) !== 0) throw new Error("release root must not be group/other writable");
  const current = lstatSync(CURRENT_LINK);
  if (!current.isSymbolicLink()) throw new Error("current must be a symbolic link");
  const target = readlinkSync(CURRENT_LINK);
  if (path.isAbsolute(target) || target.includes("/") || target === "." || target === "..") {
    throw new Error("current target must be one release name");
  }
  const lexicalTarget = path.join(RELEASES_DIR, target);
  const targetStats = lstatSync(lexicalTarget);
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) throw new Error("current target must be a directory");
  const targetPath = realpathSync(lexicalTarget);
  const canonicalRoot = realpathSync(RELEASES_DIR);
  if (path.dirname(targetPath) !== canonicalRoot) throw new Error("current target escapes release root");
  const index = lstatSync(path.join(targetPath, "index.html"));
  if (!index.isFile() || index.isSymbolicLink() || index.size === 0) throw new Error("current index.html is invalid");
}

function createStaging() {
  assertReleaseRoot();
  return mkdtempSync(path.join(RELEASES_DIR, ".staging-"));
}

function publishStaging(staging) {
  const index = lstatSync(path.join(staging, "index.html"));
  if (!index.isFile() || index.isSymbolicLink() || index.size === 0) {
    throw new Error("release index.html is invalid");
  }
  chmodSync(staging, 0o755);
  releaseSequence += 1;
  const releaseName = `release-${Date.now()}-${process.pid}-${releaseSequence}`;
  const releasePath = path.join(RELEASES_DIR, releaseName);
  renameSync(staging, releasePath);

  const temporaryLink = path.join(RELEASES_DIR, `.current-${process.pid}-${releaseSequence}`);
  try {
    symlinkSync(releaseName, temporaryLink);
    renameSync(temporaryLink, CURRENT_LINK);
  } catch (error) {
    rmSync(temporaryLink, { force: true });
    rmSync(releasePath, { recursive: true, force: true });
    throw error;
  }
  return releaseName;
}

function finishBatch(batch, status, payload) {
  for (const item of batch) sendJson(item.res, status, payload);
}

/** 有 build 在跑就进入下一批；否则在 debounce 窗口后构建当前队列。 */
function scheduleBuild(trigger) {
  if (building) {
    log("publish_queued", { trigger, queued: queued.length });
    return;
  }
  if (debounceTimer !== null) {
    log("publish_debounced", { trigger, queued: queued.length, debounceMs: DEBOUNCE_MS });
    return;
  }
  log("publish_scheduled", { trigger, queued: queued.length, debounceMs: DEBOUNCE_MS });
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    startBuild();
  }, DEBOUNCE_MS);
}

function startBuild() {
  if (building || queued.length === 0) return;
  const batch = queued;
  queued = [];
  building = true;
  const trigger = batch[0]?.summary?.event ?? "webhook";
  const jobIds = batch.map((item) => item.summary.jobId).filter(Boolean);
  const startedAt = Date.now();
  let staging;
  try {
    staging = createStaging();
  } catch (error) {
    building = false;
    log("build_prepare_error", { error: String(error?.message ?? error) });
    finishBatch(batch, 500, { published: false, error: "build_failed" });
    onBuildFinished();
    return;
  }

  log("build_start", { trigger, jobIds, batchSize: batch.length, cwd: PROJECT_DIR, staging });
  const buildEnv = { ...process.env, DOCS_OUTPUT_PATH: staging };
  delete buildEnv.ONEV_COPILOT_BASE_URL;

  let child;
  try {
    child = spawn(VOLTA_BIN, BUILD_ARGV, {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "inherit", "inherit"],
      env: buildEnv,
    });
  } catch (error) {
    building = false;
    rmSync(staging, { recursive: true, force: true });
    log("build_spawn_error", { error: String(error?.message ?? error) });
    finishBatch(batch, 500, { published: false, error: "build_failed" });
    onBuildFinished();
    return;
  }

  let settled = false;
  const finalize = (code, signal, spawnError = null) => {
    if (settled) return;
    settled = true;
    let release = null;
    let publishError = spawnError;
    if (code === 0 && signal === null && publishError === null) {
      try {
        release = publishStaging(staging);
        staging = null;
      } catch (error) {
        publishError = error;
      }
    }
    if (staging !== null) rmSync(staging, { recursive: true, force: true });
    building = false;
    const succeeded = release !== null;
    log("build_end", {
      trigger, jobIds, code, signal, succeeded, release,
      error: publishError ? String(publishError?.message ?? publishError) : undefined,
      durationMs: Date.now() - startedAt,
    });
    if (succeeded) {
      finishBatch(batch, 200, { published: true, release });
    } else {
      finishBatch(batch, 500, { published: false, error: "build_failed" });
    }
    onBuildFinished();
  };
  child.once("error", (error) => finalize(null, null, error));
  child.once("close", (code, signal) => finalize(code, signal));
}

function onBuildFinished() {
  if (queued.length > 0) {
    scheduleBuild("pending-after-build");
    return;
  }
  maybeExitAfterDrain();
}

function maybeExitAfterDrain() {
  if (!shuttingDown) return;
  if (building || queued.length > 0 || debounceTimer !== null || inFlightRequests > 0) return;
  log("shutdown_complete");
  process.exit(0);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("error", fail);
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      fail(Object.assign(new Error("body too large"), { statusCode: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        fail(Object.assign(new Error("body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overflow && !settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
  });
}

function parseNotification(raw) {
  const text = raw.trim();
  if (text === "") return {};
  let value;
  try { value = JSON.parse(text); } catch {
    throw Object.assign(new Error("invalid JSON body"), { statusCode: 400 });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("body must be a JSON object"), { statusCode: 400 });
  }
  const summary = {};
  if (value.event !== undefined) {
    if (typeof value.event !== "string") throw Object.assign(new Error("event must be a string"), { statusCode: 400 });
    summary.event = value.event;
  }
  if (value.jobId !== undefined) {
    if (typeof value.jobId !== "string") throw Object.assign(new Error("jobId must be a string"), { statusCode: 400 });
    summary.jobId = value.jobId;
  }
  if (value.components !== undefined) {
    const components = Array.isArray(value.components) ? value.components : [value.components];
    if (components.some((item) => typeof item !== "string")) {
      throw Object.assign(new Error("components must be a string or an array of strings"), { statusCode: 400 });
    }
    summary.components = components;
  }
  return summary;
}

assertReleaseRoot();

const server = http.createServer(async (req, res) => {
  inFlightRequests += 1;
  let responseReleased = false;
  const releaseResponse = () => {
    if (responseReleased) return;
    responseReleased = true;
    inFlightRequests -= 1;
    maybeExitAfterDrain();
  };
  res.once("finish", releaseResponse);
  res.once("close", releaseResponse);

  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, {
      status: "ok", building, pending: queued.length > 0,
      debouncePending: debounceTimer !== null, shuttingDown,
    });
    return;
  }
  if (url.pathname !== "/publish") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (shuttingDown) {
    sendJson(res, 503, { published: false, error: "shutting_down" }, { connection: "close" });
    return;
  }

  try {
    const summary = parseNotification(await readBody(req));
    queued.push({ summary, res });
    log("publish_accepted", { notification: summary, queued: queued.length });
    scheduleBuild(summary.event ?? "webhook");
  } catch (error) {
    const status = Number(error?.statusCode) || 400;
    log("publish_rejected", { status, error: String(error?.message ?? error) });
    if (status === 413) {
      if (!req.complete) req.resume();
      sendJson(res, 413, { published: false, error: "body_too_large" }, { connection: "close" });
    } else {
      sendJson(res, status, { published: false, error: "invalid_request" });
    }
  }
});

server.on("error", (error) => {
  log("server_error", { error: String(error?.message ?? error) });
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  log("listening", { host: HOST, port: PORT, projectDir: PROJECT_DIR, releasesDir: RELEASES_DIR });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", { signal, building, queued: queued.length, debouncePending: debounceTimer !== null });
  server.close();
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
  maybeExitAfterDrain();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
