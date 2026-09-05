// WP4B 发布产物卫生检查（build:file-ops / build:backup / build 共用）：
// - `clean`：先清空生成目录再编译，残留的旧 executor/file-system-policy 编译产物
//   不可能进入新发布产物（tsc 不会删除 outDir 中已不存在的源文件产物）；
// - `check`：递归断言目录树内没有任何符号链接（防止经 symlink 走私源码/文件）且
//   没有任何被移除模块的残留文件名（executor / file-system-policy / error-codes，
//   这些只属于已移除的 WP4B 物理执行器；health-core 只属于已放弃的 WP5C 方案 A
//   backup health scanner——均不允许出现在任何 dist 产物中）。
//
// 用法：
//   node scripts/dist-hygiene.mjs clean dist [dist-backup ...]
//   node scripts/dist-hygiene.mjs check dist-file-ops
import { lstatSync, readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

/** 已移除模块的残留文件名（basename 精确匹配，任意目录层级都禁止）。 */
const FORBIDDEN_DIST_BASENAMES = new Set([
  // WP4B 物理执行器（方案 A 已移除，绝不允许作为编译产物回归）。
  "executor.js", "executor.d.ts", "executor.js.map", "executor.d.ts.map",
  "file-system-policy.js", "file-system-policy.d.ts", "file-system-policy.js.map", "file-system-policy.d.ts.map",
  // 已移除执行器的错误码模块（last_error 现在只用 file-operation-policy 的 allowlist）。
  "error-codes.js", "error-codes.d.ts", "error-codes.js.map", "error-codes.d.ts.map",
  // WP5C 方案 A backup health scanner（已放弃，绝不回归）：health-core 只能来自
  // 被放弃的仓库内只读 backup-health scanner（曾编译产出 dist/backup-health/）。
  "health-core.js", "health-core.d.ts", "health-core.js.map", "health-core.d.ts.map",
]);

/** 递归检查：先探符号链接，再检查残留文件名。 */
export function checkDistHygiene(root) {
  if (!existsSync(root)) throw new Error(`dist hygiene: 输出目录不存在：${root}`);
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const entry = path.join(directory, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) throw new Error(`dist hygiene: 禁止符号链接：${entry}`);
      if (stat.isDirectory()) {
        walk(entry);
      } else if (stat.isFile() && FORBIDDEN_DIST_BASENAMES.has(name)) {
        throw new Error(`dist hygiene: 禁止的残留产物：${entry}`);
      }
    }
  };
  walk(root);
}

export function cleanDistRoots(roots) {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

function isCliEntry() {
  try {
    return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  const [command, ...roots] = process.argv.slice(2);
  if (roots.length === 0) {
    console.error("dist hygiene: 缺少输出目录参数");
    process.exitCode = 2;
  } else if (command === "clean") {
    cleanDistRoots(roots);
  } else if (command === "check") {
    try {
      for (const root of roots) checkDistHygiene(root);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    console.error("dist hygiene: 未知命令（仅支持 clean / check）");
    process.exitCode = 2;
  }
}