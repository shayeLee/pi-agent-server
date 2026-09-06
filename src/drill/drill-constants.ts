/**
 * Shared drill constants / helpers with no cross-module coupling (avoids ESM cycles).
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** 受控 Podman 资源前缀：拒绝任何不带该前缀的资源。 */
export const DRILL_RESOURCE_PREFIX = "pi-agent-server-disaster-recovery-drill-";
export const PG_MAJOR = "16";

/**
 * 从本模块位置向上定位包根（含 dist-backup / dist-migrate），使编译产物与已安装包都能
 * 找到执行器所需编译 CLI；找不到时回退进程 cwd。
 */
export function findPackageRoot(moduleDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let current = moduleDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, "dist-backup", "scripts", "backup.js")) && existsSync(path.join(current, "dist-migrate", "scripts", "migrate.js"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}
