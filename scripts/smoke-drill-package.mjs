import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkDistHygiene } from "./dist-hygiene.mjs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.bin?.["pi-agent-server-drill"] !== "./dist-drill/scripts/drill.js" || !packageJson.files?.includes("dist-drill") || !packageJson.files?.includes("docker/scheduler") || !existsSync("dist-drill/scripts/drill.js")) {
  throw new Error("compiled drill package bin is missing or points outside dist-drill");
}

const directory = mkdtempSync(path.join(tmpdir(), "pi-drill-package-smoke-"));
const cache = path.join(directory, "npm-cache");
const packageDir = path.join(directory, "package");
const installDir = path.join(directory, "install");
let drillRoot = "";

function run(command, args, options = {}) {
  return spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8" });
}

function npm(args) {
  return run("npm", ["--no-audit", "--no-fund", ...args], {
    env: { ...process.env, npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
  });
}

try {
  mkdirSync(packageDir, { recursive: true, mode: 0o700 });
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const packed = npm(["pack", "--pack-destination", packageDir]);
  const tarball = packed.stdout.trim().split(/\r?\n/).at(-1);
  if (!tarball || !existsSync(path.join(packageDir, tarball))) throw new Error("npm pack tarball is missing");
  npm(["install", "--ignore-scripts", "--prefix", installDir, path.join(packageDir, tarball)]);
  const packageRoot = path.join(installDir, "node_modules", packageJson.name);
  checkDistHygiene(packageRoot);
  const drillBin = path.join(installDir, "node_modules", ".bin", "pi-agent-server-drill");
  if (!existsSync(drillBin)) throw new Error("installed drill bin is missing");
  if (!existsSync(path.join(packageRoot, "docker", "scheduler", "Containerfile")) || !existsSync(path.join(packageRoot, "docker", "scheduler", "scheduler-node.mjs"))) {
    throw new Error("installed drill scheduler image context is missing");
  }

  // 安装后的 bin 无 PI_DRILL_ROOT → preflight FAIL（exit 2），不起 podman。
  const noRootEnv = { ...process.env };
  delete noRootEnv.PI_DRILL_ROOT;
  const noRoot = run(drillBin, ["run"], { env: noRootEnv });
  if (noRoot.status !== 2) throw new Error(`installed drill run without PI_DRILL_ROOT expected exit 2, got ${noRoot.status}`);

  // 安装后的 bin preflight：有 root、secrets → exit 0。
  drillRoot = path.join(directory, "drill-root");
  mkdirSync(path.join(drillRoot, "secrets"), { recursive: true, mode: 0o700 });
  chmodSync(drillRoot, 0o700);
  writeFileSync(path.join(drillRoot, "secrets", "age-identity.txt"), "AGE-SECRET-KEY-PKG", { mode: 0o600 });
  writeFileSync(path.join(drillRoot, "secrets", "age-recipient.txt"), "age1pkgrecipient\n", { mode: 0o600 });
  const preflightCli = run(drillBin, ["preflight"], { env: { ...process.env, PI_DRILL_ROOT: drillRoot } });
  if (preflightCli.status !== 0) throw new Error(`installed preflight expected exit 0, got ${preflightCli.status}`);
  if (preflightCli.stdout.includes(drillRoot) || preflightCli.stdout.includes("AGE-SECRET-KEY-PKG") || preflightCli.stdout.includes("postgres://")) {
    throw new Error("installed drill leaked the root/secret/URL");
  }

  console.log("installed npm drill preflight/redaction + bin smoke: ok");
} finally {
  if (drillRoot) rmSync(directory, { recursive: true, force: true });
}
