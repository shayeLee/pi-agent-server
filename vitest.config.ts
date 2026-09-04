import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Hermetic plaintext-staging root for the whole test run. Tests that exercise
// the DEFAULT staging path (no explicit stagingRoot) would otherwise touch the
// real per-user config root; pointing PI_BACKUP_STAGING_ROOT (the same
// variable the backup/migrate/cutover CLIs honor) at a private directory under
// node_modules keeps every test run hermetic and off the shared OS temp tree.
// The directory chain is current-user owned and created 0700 on first use.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_BACKUP_STAGING_ROOT = path.join(projectRoot, "node_modules", ".pi-test-staging");
mkdirSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, mode: 0o700 });

export default defineConfig({
  test: {
    // 根目录只跑服务端测试；web/ 子包有独立的 vitest 配置
    include: ["tests/**/*.test.ts"],
    projects: [
      {
        // 真实外部集成门禁（tests/postgres/**）：pg_dump/pg_restore/age/migration
        // 共享同一台真实 PG 服务器与宿主机工具，文件级并行会人为放大调度延迟，
        // 曾使 WP3C prebackup 的 age 阶段在完整 root test 中误触发安全预算。
        // 仅对这组外部集成关掉文件并行；其余测试保持默认并行。
        test: {
          name: "pg-integration",
          include: ["tests/postgres/**/*.test.ts"],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/postgres/**/*.test.ts"],
        },
      },
    ],
  },
});
