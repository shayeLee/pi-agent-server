// dist-reconcile 最小依赖闭包（strict hygiene）断言：默认拒绝，只有下面这份
// 按字典序固定的 manifest 可以进入发布产物。manifest 同时包含目录和生成的
// JS/declaration/map 文件，因此新增依赖或残留文件都会使构建门禁失败。
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

export const RECONCILE_CLOSURE_MANIFEST = Object.freeze([
  "scripts/",
  "scripts/reconcile-jsonl.d.ts",
  "scripts/reconcile-jsonl.d.ts.map",
  "scripts/reconcile-jsonl.js",
  "scripts/reconcile-jsonl.js.map",
  "src/",
  "src/agent/",
  "src/agent/pi-jsonl-reference.d.ts",
  "src/agent/pi-jsonl-reference.d.ts.map",
  "src/agent/pi-jsonl-reference.js",
  "src/agent/pi-jsonl-reference.js.map",
  "src/application/",
  "src/application/ports/",
  "src/application/ports/project-store-port.d.ts",
  "src/application/ports/project-store-port.d.ts.map",
  "src/application/ports/project-store-port.js",
  "src/application/ports/project-store-port.js.map",
  "src/application/ports/reconcile-reference-port.d.ts",
  "src/application/ports/reconcile-reference-port.d.ts.map",
  "src/application/ports/reconcile-reference-port.js",
  "src/application/ports/reconcile-reference-port.js.map",
  "src/file-operations/",
  "src/file-operations/reconcile.d.ts",
  "src/file-operations/reconcile.d.ts.map",
  "src/file-operations/reconcile.js",
  "src/file-operations/reconcile.js.map",
  "src/storage/",
  "src/storage/db-schema.d.ts",
  "src/storage/db-schema.d.ts.map",
  "src/storage/db-schema.js",
  "src/storage/db-schema.js.map",
  "src/storage/kysely-reconcile-reference-repository.d.ts",
  "src/storage/kysely-reconcile-reference-repository.d.ts.map",
  "src/storage/kysely-reconcile-reference-repository.js",
  "src/storage/kysely-reconcile-reference-repository.js.map",
  "src/storage/migration-engine.d.ts",
  "src/storage/migration-engine.d.ts.map",
  "src/storage/migration-engine.js",
  "src/storage/migration-engine.js.map",
  "src/storage/migration-manifest.d.ts",
  "src/storage/migration-manifest.d.ts.map",
  "src/storage/migration-manifest.js",
  "src/storage/migration-manifest.js.map",
  "src/storage/migration-renderer.d.ts",
  "src/storage/migration-renderer.d.ts.map",
  "src/storage/migration-renderer.js",
  "src/storage/migration-renderer.js.map",
  "src/storage/node-sqlite-adapter.d.ts",
  "src/storage/node-sqlite-adapter.d.ts.map",
  "src/storage/node-sqlite-adapter.js",
  "src/storage/node-sqlite-adapter.js.map",
  "src/storage/pg-int8.d.ts",
  "src/storage/pg-int8.d.ts.map",
  "src/storage/pg-int8.js",
  "src/storage/pg-int8.js.map",
  "src/storage/postgres-bootstrap.d.ts",
  "src/storage/postgres-bootstrap.d.ts.map",
  "src/storage/postgres-bootstrap.js",
  "src/storage/postgres-bootstrap.js.map",
  "src/storage/postgres-connection.d.ts",
  "src/storage/postgres-connection.d.ts.map",
  "src/storage/postgres-connection.js",
  "src/storage/postgres-connection.js.map",
  "src/storage/postgres-schema-guard.d.ts",
  "src/storage/postgres-schema-guard.d.ts.map",
  "src/storage/postgres-schema-guard.js",
  "src/storage/postgres-schema-guard.js.map",
  "src/storage/schema-builder.d.ts",
  "src/storage/schema-builder.d.ts.map",
  "src/storage/schema-builder.js",
  "src/storage/schema-builder.js.map",
  "src/storage/schema-compatibility.d.ts",
  "src/storage/schema-compatibility.d.ts.map",
  "src/storage/schema-compatibility.js",
  "src/storage/schema-compatibility.js.map",
  "src/storage/schema-manifest.d.ts",
  "src/storage/schema-manifest.d.ts.map",
  "src/storage/schema-manifest.js",
  "src/storage/schema-manifest.js.map",
  "src/storage/schema-types.d.ts",
  "src/storage/schema-types.d.ts.map",
  "src/storage/schema-types.js",
  "src/storage/schema-types.js.map",
  "src/storage/sqlite-write-lock.d.ts",
  "src/storage/sqlite-write-lock.d.ts.map",
  "src/storage/sqlite-write-lock.js",
  "src/storage/sqlite-write-lock.js.map",
  "src/storage/storage-config.d.ts",
  "src/storage/storage-config.d.ts.map",
  "src/storage/storage-config.js",
  "src/storage/storage-config.js.map",
]);

function compareManifestEntries(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSortedManifest() {
  for (let index = 1; index < RECONCILE_CLOSURE_MANIFEST.length; index += 1) {
    if (compareManifestEntries(RECONCILE_CLOSURE_MANIFEST[index - 1], RECONCILE_CLOSURE_MANIFEST[index]) >= 0) {
      throw new Error("reconcile closure: manifest must be unique and sorted");
    }
  }
}

/** 递归收集发布目录中的目录/文件 manifest（只读，不执行任何写入）。 */
function collectManifest(root) {
  const entries = [];
  const walk = (directory, rel) => {
    for (const name of readdirSync(directory).sort(compareManifestEntries)) {
      const entry = path.join(directory, name);
      const entryRel = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) throw new Error(`reconcile closure: 禁止符号链接：${entryRel}`);
      if (stat.isDirectory()) {
        entries.push(`${entryRel}/`);
        walk(entry, entryRel);
      } else if (stat.isFile()) {
        entries.push(entryRel);
      } else {
        throw new Error(`reconcile closure: 禁止特殊文件：${entryRel}`);
      }
    }
  };
  walk(root, "");
  return entries.sort(compareManifestEntries);
}

/** 递归断言 dist-reconcile 闭包：manifest 之外的内容默认拒绝。 */
export function checkReconcileClosure(root) {
  assertSortedManifest();
  if (!existsSync(root)) throw new Error(`reconcile closure: 输出目录不存在：${root}`);
  const actual = collectManifest(root);
  const expected = [...RECONCILE_CLOSURE_MANIFEST];
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    const unexpected = actual.filter((entry) => !expected.includes(entry));
    const missing = expected.filter((entry) => !actual.includes(entry));
    throw new Error(`reconcile closure: manifest 不匹配（unexpected=${unexpected.join(",")}; missing=${missing.join(",")})`);
  }
}
