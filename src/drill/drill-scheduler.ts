/**
 * Scheduler container manager for the backup-freshness drill.
 *
 * Proves the deployment contract "scheduler -> fixed compiled backup CLI -> published
 * report -> textfile freshness". A real, isolated scheduler container (built from the
 * project's `docker/scheduler` image: Node + age + PostgreSQL 16 client + cron) mounts
 * the compiled project (dist-backup / dist-migrate / node_modules) read-only and the
 * drill root at `/drill`. The container runs (a) crond on a per-minute timer and (b)
 * an on-demand watcher. The host orchestrator writes a trigger `request.json` into a
 * safe file under the drill root; the scheduler picks it up, runs the compiled CLI
 * inside the container, and writes `result.json` which the host polls.
 *
 * All resources use the `pi-agent-server-disaster-recovery-drill-` prefix.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { DRILL_RESOURCE_PREFIX, findPackageRoot } from "./drill-constants.js";

export const SCHEDULER_IMAGE = process.env.PI_DRILL_SCHEDULER_IMAGE || `${DRILL_RESOURCE_PREFIX}scheduler:latest`;
/** Inside the container, the drill root is mounted at /drill and the project at /app.
 * Mounting the drill root at a short, clean path avoids sticky/shared ancestor bits that the
 * podman macOS VM attaches to the identity-mount parent dirs (which would reject the plaintext
 * staging ancestor chain). Host<->container path mapping is handled by to/fromContainerPath. */
export const CONTAINER_DRILL_ROOT = "/drill";
export const CONTAINER_PROJECT_ROOT = "/app";

export type SchedulerTrigger = "watch" | "cron";

export interface SchedulerState {
  readonly name: string;
  readonly network: string;
  readonly schedulerDir: string;
  readonly projectRoot: string;
  readonly drillRoot: string;
  readonly image: string;
  readonly ownsImage: boolean;
  readonly resourcePrefix: string;
  readonly containerId: string;
  started: boolean;
}

export interface SchedulerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly doneAt: string;
  readonly trigger: SchedulerTrigger;
  /** Timestamp recorded by the process that claimed the request. */
  readonly triggerAt: string;
  readonly requestedAt?: string;
}

function podman(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("podman", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { status: -1, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function imageExists(image: string): boolean {
  const result = podman(["image", "exists", image]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("scheduler image existence check failed");
}

function containerExists(name: string): boolean {
  const result = podman(["container", "exists", name]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("scheduler container existence check failed");
}

/** Ensure a run-owned scheduler image is present, building it if necessary. */
export function ensureSchedulerImage(image = SCHEDULER_IMAGE): boolean {
  if (imageExists(image)) return false;
  const pkgRoot = findPackageRoot();
  const context = path.join(pkgRoot, "docker", "scheduler");
  if (!existsSync(path.join(context, "Containerfile"))) throw new Error("scheduler Containerfile not found");
  const result = podman(["build", "-t", image, "-f", path.join(context, "Containerfile"), context]);
  if (result.status !== 0) throw new Error("scheduler image build failed");
  return true;
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        const port = typeof address === "object" && address !== null ? address.port : 0;
        if (port === 0) reject(new Error("could not allocate a free host port"));
        else resolve(port);
      });
    });
  });
}

/** Map a host path that lives under the drill root into the container `/drill` path. */
export function toContainerPath(hostRoot: string, hostPath: string): string {
  const rel = path.relative(hostRoot, hostPath);
  if (rel === "") return CONTAINER_DRILL_ROOT;
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path not under drill root: ${hostPath}`);
  return path.posix.join(CONTAINER_DRILL_ROOT, rel.split(path.sep).join("/"));
}

/** Map a container `/drill/...` path back to the host drill root. */
export function fromContainerPath(hostRoot: string, containerPath: string): string {
  if (!containerPath.startsWith(CONTAINER_DRILL_ROOT)) return containerPath;
  const rel = containerPath.slice(CONTAINER_DRILL_ROOT.length).replace(/^\//, "");
  return path.join(hostRoot, rel.split("/").join(path.sep));
}

/** Start the scheduler container. projectRoot is mounted read-only; drillRoot is mounted rw. */
export async function startScheduler(projectRoot: string, drillRoot: string, resourcePrefix = DRILL_RESOURCE_PREFIX, network = `${resourcePrefix}net`): Promise<SchedulerState> {
  const configuredImage = process.env.PI_DRILL_SCHEDULER_IMAGE;
  const image = configuredImage || `${resourcePrefix}scheduler:latest`;
  const ownsImage = ensureSchedulerImage(image);
  const name = `${resourcePrefix}scheduler`;
  const schedulerDir = path.join(drillRoot, "scheduler");
  mkdirSync(schedulerDir, { recursive: true, mode: 0o700 });
  if (containerExists(name)) throw new Error("scheduler resource collision");
  const networkExists = podman(["network", "exists", network]);
  if (networkExists.status !== 0) throw new Error("scheduler network is not provisioned");
  const dependencyMount = resolveDependencyNodeModules(projectRoot);
  const result = podman([
    "run", "-d", "--name", name, "--network", network,
    "--label", `pi-agent-server.drill.run=${resourcePrefix}`,
    "-v", `${projectRoot}:${CONTAINER_PROJECT_ROOT}:ro`,
    ...(dependencyMount ? ["-v", `${dependencyMount}:${path.posix.join(CONTAINER_PROJECT_ROOT, "node_modules")}:ro`] : []),
    "-v", `${drillRoot}:${CONTAINER_DRILL_ROOT}:rw`,
    "-e", `DRILL_SCHEDULER_DIR=${path.posix.join(CONTAINER_DRILL_ROOT, "scheduler")}`,
    "-e", `DRILL_CLI_ROOT=${CONTAINER_PROJECT_ROOT}`,
    image,
  ]);
  if (result.status !== 0) {
    if (ownsImage) podman(["image", "rm", image]);
    throw new Error("scheduler start failed");
  }
  const createdId = podman(["container", "inspect", "-f", "{{.Id}}", name]).stdout.trim();
  if (!createdId) {
    podman(["rm", "-f", name]);
    if (ownsImage) podman(["image", "rm", image]);
    throw new Error("scheduler identity unavailable");
  }
  const heartbeat = path.join(schedulerDir, "heartbeat");
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(heartbeat)) return { name, network, schedulerDir, projectRoot, drillRoot, image, ownsImage, resourcePrefix, containerId: createdId, started: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  podman(["rm", "-f", name]);
  if (ownsImage) podman(["image", "rm", image]);
  throw new Error("scheduler did not become ready");
}

/** Write a trigger request and return its host directory. Cron requests are claimed
 * only by the cron worker; the watcher explicitly skips them. */
export function submitRequest(
  state: SchedulerState,
  id: string,
  cli: { backup: string },
  argv: readonly string[],
  env: Record<string, string>,
  trigger: SchedulerTrigger = "watch",
): string {
  const hostDir = path.join(state.schedulerDir, id);
  mkdirSync(hostDir, { recursive: true, mode: 0o700 });
  const containerCli = rewriteToRoot(state.projectRoot, cli.backup, CONTAINER_PROJECT_ROOT);
  const request = {
    id,
    trigger,
    requestedAt: new Date().toISOString(),
    cli: { backup: containerCli },
    argv: argv.map((a) => rewriteToRoot(state.drillRoot, a, CONTAINER_DRILL_ROOT)),
    env: Object.fromEntries(
      sanitizeContainerEnv(env)
        .map(([k, v]) => [k, rewriteToRoot(state.drillRoot, v, CONTAINER_DRILL_ROOT)]),
    ),
  };
  writeFileSync(path.join(hostDir, "request.json"), JSON.stringify(request), { mode: 0o600 });
  return hostDir;
}

/** Strict scheduler environment contract. Nothing inherited from the host is
 * serialized unless the backup CLI explicitly needs it. In particular this
 * excludes PATH, cloud credentials, model/API keys, bearer tokens and shell
 * metadata. The container supplies its own HOME/PATH; DRILL_PREPEND_PATH is
 * consumed only for the drill's dedicated fake PostgreSQL tools. */
export const SCHEDULER_ENV_ALLOWLIST = Object.freeze([
  "AGENT_CWD", "DATA_DIR", "DB_PATH", "PI_AGENT_DIR", "PI_AUTH_PATH",
  "PI_STORAGE_DIALECT", "PI_DATABASE_URL", "PI_BACKUP_STAGING_ROOT", "DRILL_PREPEND_PATH",
] as const);

export function sanitizeContainerEnv(env: Record<string, string>): Array<[string, string]> {
  const allowed = new Set<string>(SCHEDULER_ENV_ALLOWLIST);
  return Object.entries(env).filter(([key, value]) => allowed.has(key) && value.length > 0);
}

/** Locate a real production dependency tree for the compiled CLI. The project
 * itself is mounted read-only; the returned node_modules is mounted read-only
 * at /app/node_modules as well, which also works for npm's hoisted install
 * layout. */
export function resolveDependencyNodeModules(projectRoot: string): string | null {
  let current = path.resolve(projectRoot);
  for (;;) {
    const candidate = path.join(current, "node_modules");
    if (existsSync(path.join(candidate, "kysely")) && existsSync(path.join(candidate, "pg"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Rewrite a host absolute path to the container path for the given root. */
function rewriteToRoot(hostRoot: string, value: string, containerRoot: string): string {
  if (!value) return value;
  if (!path.isAbsolute(value)) return value;
  const rel = path.relative(hostRoot, value);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return path.posix.join(containerRoot, rel.split(path.sep).join("/"));
  }
  return value;
}

/** Poll for the scheduler result until it appears or timeout elapses. Returns parsed result or null. */
export async function pollResult(state: SchedulerState, id: string, timeoutMs = 60000): Promise<SchedulerResult | null> {
  const resultFile = path.join(state.schedulerDir, id, "result.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultFile)) {
      try {
        const parsed = JSON.parse(readFileSync(resultFile, "utf8"));
        return parsed as SchedulerResult;
      } catch {
        return null;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** Remove the request dir artifacts for a completed request id. */
export function removeRequest(state: SchedulerState, id: string): void {
  const dir = path.join(state.schedulerDir, id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Stop/remove only this run's scheduler container. Shared base images are never removed. */
export async function stopScheduler(state: SchedulerState): Promise<void> {
  if (containerExists(state.name)) {
    const actual = podman(["container", "inspect", "-f", "{{.Id}}", state.name]);
    if (actual.status !== 0 || actual.stdout.trim() !== state.containerId) throw new Error("scheduler resource ownership changed");
    if (podman(["rm", "-f", state.name]).status !== 0 || containerExists(state.name)) throw new Error("scheduler container cleanup failed");
  }
  if (state.ownsImage && imageExists(state.image) && (podman(["image", "rm", state.image]).status !== 0 || imageExists(state.image))) throw new Error("scheduler image cleanup failed");
  state.started = false;
}
