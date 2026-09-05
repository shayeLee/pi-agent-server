// WP5D-4 owner transfer 核心（SQLite 路径，隔离临时目录，零真实数据）。
// 覆盖：成功转移（default 项目 owner='' 保留、source sessions 跨 default/自定义项目迁移）、
// target 非空不合并、source 无资源、default 项目缺失/owner 非空、错位引用（source session
// 引用非 source 自定义项目、他人 session 引用 source 项目）→ 事务 ROLLBACK 后状态不变、
// 只更新 owner_key 两列、dry-run 只读分析零写入。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import {
  analyzeSqliteOwnerTransferReadOnly,
  ownerKeyForIp,
  planOwnerTransfer,
  runSqliteOwnerTransfer,
} from "../../src/owner-transfer/owner-transfer-core.js";

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const SOURCE = ownerKeyForIp("10.1.2.3");
const TARGET = ownerKeyForIp("10.1.2.4");
const OTHER = ownerKeyForIp("10.1.2.5");

interface FixtureState {
  dbPath: string;
  /** project id -> ownerKey (仅自定义项目；default 项目恒 '') */
  projects: Array<{ id: string; ownerKey: string }>;
  sessions: Array<{ id: string; ownerKey: string; projectId: string }>;
}

function insertProjects(db: DatabaseSync, projects: FixtureState["projects"]): void {
  const insert = db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)");
  for (const project of projects) insert.run(project.id, "p", "/cwd", project.ownerKey, 1);
}

function insertSessions(db: DatabaseSync, sessions: FixtureState["sessions"]): void {
  const insert = db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const session of sessions) insert.run(session.id, session.ownerKey, session.projectId, "t", 1, 1, null, "{}");
}

async function createFixture(state: Partial<FixtureState> = {}): Promise<FixtureState> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-test-"));
  cleanups.push(root);
  const dataDir = path.join(root, "data");
  mkdirSync(path.join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dataDir, "sessions", ".keep"), "", { mode: 0o600 });
  const dbPath = path.join(dataDir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  await initializeDatabase(db);
  // Default project row (owner '') must exist for every valid transfer.
  insertProjects(db, [{ id: DEFAULT_PROJECT_ID, ownerKey: "" }]);
  insertProjects(db, state.projects ?? [{ id: "p1", ownerKey: SOURCE }]);
  insertSessions(db, state.sessions ?? [
    { id: "s1", ownerKey: SOURCE, projectId: "p1" },
    { id: "s2", ownerKey: SOURCE, projectId: DEFAULT_PROJECT_ID },
    { id: "s3", ownerKey: OTHER, projectId: DEFAULT_PROJECT_ID },
  ]);
  db.close();
  return { dbPath, projects: [{ id: DEFAULT_PROJECT_ID, ownerKey: "" }, ...(state.projects ?? [{ id: "p1", ownerKey: SOURCE }])], sessions: state.sessions ?? [{ id: "s1", ownerKey: SOURCE, projectId: "p1" }, { id: "s2", ownerKey: SOURCE, projectId: DEFAULT_PROJECT_ID }, { id: "s3", ownerKey: OTHER, projectId: DEFAULT_PROJECT_ID }] };
}

function readState(dbPath: string): { projects: Array<{ id: string; owner_key: string }>; sessions: Array<{ id: string; owner_key: string; project_id: string }> } {
  const db = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true });
  try {
    const projects = db.prepare("SELECT id, owner_key FROM projects ORDER BY id").all() as Array<{ id: string; owner_key: string }>;
    const sessions = db.prepare("SELECT id, owner_key, project_id FROM sessions ORDER BY id").all() as Array<{ id: string; owner_key: string; project_id: string }>;
    return { projects, sessions };
  } finally { db.close(); }
}

describe("owner-transfer core (SQLite)", () => {
  it("transfers exactly owner_key on source projects and sessions and preserves the default project owner ''", async () => {
    const fixture = await createFixture();
    const db = new DatabaseSync(fixture.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
    try {
      const plan = runSqliteOwnerTransfer(db, SOURCE, TARGET);
      expect(plan).toEqual({ projectsTransferred: 1, sessionsTransferred: 2, defaultProjectOwnerPreserved: true });
    } finally { db.close(); }
    const state = readState(fixture.dbPath);
    const owners = Object.fromEntries(state.projects.map((p) => [p.id, p.owner_key]));
    const sessionOwners = Object.fromEntries(state.sessions.map((s) => [s.id, s.owner_key]));
    expect(owners[DEFAULT_PROJECT_ID]).toBe("");
    expect(owners.p1).toBe(TARGET);
    expect(sessionOwners.s1).toBe(TARGET);
    expect(sessionOwners.s2).toBe(TARGET);
    expect(sessionOwners.s3).toBe(OTHER);
    // Source owner is now fully empty.
    expect(state.projects.filter((p) => p.owner_key === SOURCE)).toHaveLength(0);
    expect(state.sessions.filter((s) => s.owner_key === SOURCE)).toHaveLength(0);
  });

  it("refuses a target owner that already holds resources (no merge) and rolls back to zero writes", async () => {
    const fixture = await createFixture({
      projects: [{ id: "p1", ownerKey: SOURCE }, { id: "p2", ownerKey: TARGET }],
      sessions: [{ id: "s1", ownerKey: SOURCE, projectId: "p1" }, { id: "s2", ownerKey: TARGET, projectId: "p2" }],
    });
    const before = JSON.stringify(readState(fixture.dbPath));
    const db = new DatabaseSync(fixture.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
    try {
      expect(() => runSqliteOwnerTransfer(db, SOURCE, TARGET)).toThrow(/merge is not supported/);
    } finally { db.close(); }
    expect(JSON.stringify(readState(fixture.dbPath))).toBe(before);
  });

  it("refuses a source owner without any resource", async () => {
    const fixture = await createFixture({
      projects: [],
      sessions: [{ id: "s1", ownerKey: OTHER, projectId: DEFAULT_PROJECT_ID }],
    });
    const db = new DatabaseSync(fixture.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
    try {
      expect(() => runSqliteOwnerTransfer(db, SOURCE, TARGET)).toThrow(/no resources to transfer/);
    } finally { db.close(); }
  });

  it("refuses when the default project row is missing or has a non-empty owner", async () => {
    // Missing default project row (no projects at all besides a source project).
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-nodefault-")), "db.sqlite");
    cleanups.push(path.dirname(dbPath));
    const db = new DatabaseSync(dbPath);
    await initializeDatabase(db);
    insertProjects(db, [{ id: "p1", ownerKey: SOURCE }]);
    insertSessions(db, [{ id: "s1", ownerKey: SOURCE, projectId: "p1" }]);
    db.prepare("DELETE FROM projects WHERE id = ?").run(DEFAULT_PROJECT_ID);
    db.close();
    const noDefault = new DatabaseSync(dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
    try { expect(() => runSqliteOwnerTransfer(noDefault, SOURCE, TARGET)).toThrow(/default project row/); }
    finally { noDefault.close(); }

    // Default project with a non-empty owner.
    const second = await createFixture();
    const db2 = new DatabaseSync(second.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
    db2.prepare("UPDATE projects SET owner_key = ? WHERE id = ?").run("ip:someone-else", DEFAULT_PROJECT_ID);
    try { expect(() => runSqliteOwnerTransfer(db2, SOURCE, TARGET)).toThrow(/non-empty owner/); }
    finally { db2.close(); }
  });

  it("refuses a source session referencing a custom project owned by another owner and rolls back", async () => {
    const fixture = await createFixture({
      projects: [{ id: "p1", ownerKey: SOURCE }, { id: "p2", ownerKey: OTHER }],
      sessions: [{ id: "s1", ownerKey: SOURCE, projectId: "p1" }, { id: "s2", ownerKey: SOURCE, projectId: "p2" }],
    });
    const before = JSON.stringify(readState(fixture.dbPath));
    const db = new DatabaseSync(fixture.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
    try {
      expect(() => runSqliteOwnerTransfer(db, SOURCE, TARGET)).toThrow(/references a custom project owned by another owner/);
    } finally { db.close(); }
    expect(JSON.stringify(readState(fixture.dbPath))).toBe(before);
  });

  it("refuses an other-owner session referencing a source project and rolls back", async () => {
    const fixture = await createFixture({
      projects: [{ id: "p1", ownerKey: SOURCE }],
      sessions: [{ id: "s1", ownerKey: SOURCE, projectId: "p1" }, { id: "s2", ownerKey: OTHER, projectId: "p1" }],
    });
    const before = JSON.stringify(readState(fixture.dbPath));
    const db = new DatabaseSync(fixture.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
    try {
      expect(() => runSqliteOwnerTransfer(db, SOURCE, TARGET)).toThrow(/owned by another owner references a project owned by the source owner/);
    } finally { db.close(); }
    expect(JSON.stringify(readState(fixture.dbPath))).toBe(before);
  });

  it("touches only owner_key columns (other columns stay byte-identical per row)", async () => {
    const fixture = await createFixture();
    const beforeRows: Record<string, string[]> = {};
    {
      const db = new DatabaseSync(fixture.dbPath, { readOnly: true, enableForeignKeyConstraints: true });
      for (const row of db.prepare("SELECT * FROM projects ORDER BY id").all() as Array<Record<string, unknown>>) beforeRows[`p:${row.id}`] = Object.values(row).map(String);
      for (const row of db.prepare("SELECT * FROM sessions ORDER BY id").all() as Array<Record<string, unknown>>) beforeRows[`s:${row.id}`] = Object.values(row).map(String);
      db.close();
    }
    const db = new DatabaseSync(fixture.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
    try { runSqliteOwnerTransfer(db, SOURCE, TARGET); } finally { db.close(); }
    const db2 = new DatabaseSync(fixture.dbPath, { readOnly: true, enableForeignKeyConstraints: true });
    try {
      for (const row of db2.prepare("SELECT * FROM projects ORDER BY id").all() as Array<Record<string, unknown>>) {
        const key = `p:${row.id}`;
        const expected = beforeRows[key]!;
        const actual = Object.values(row).map(String);
        for (let i = 0; i < expected.length; i++) {
          const column = Object.keys(row)[i]!;
          if (column === "owner_key") continue; // only owner_key may change
          expect(actual[i], `${key}.${column}`).toBe(expected[i]);
        }
        if (row.id === DEFAULT_PROJECT_ID) expect(row.owner_key).toBe("");
      }
      for (const row of db2.prepare("SELECT * FROM sessions ORDER BY id").all() as Array<Record<string, unknown>>) {
        const key = `s:${row.id}`;
        const expected = beforeRows[key]!;
        const actual = Object.values(row).map(String);
        for (let i = 0; i < expected.length; i++) {
          const column = Object.keys(row)[i]!;
          if (column === "owner_key") continue;
          expect(actual[i], `${key}.${column}`).toBe(expected[i]);
        }
      }
    } finally { db2.close(); }
  });

  it("dry-run analysis returns the same plan without writing", async () => {
    const fixture = await createFixture();
    const db = new DatabaseSync(fixture.dbPath, { timeout: 5000, readOnly: true, enableForeignKeyConstraints: true });
    try {
      const plan = analyzeSqliteOwnerTransferReadOnly(db, SOURCE, TARGET);
      expect(plan.projectsTransferred).toBe(1);
      expect(plan.sessionsTransferred).toBe(2);
      expect(plan.defaultProjectOwnerPreserved).toBe(true);
    } finally { db.close(); }
  });

  it("pure planOwnerTransfer rejects cross-pointing states on arbitrary rows", () => {
    expect(() => planOwnerTransfer({
      sourceOwnerKey: SOURCE,
      targetOwnerKey: TARGET,
      projects: [
        { id: DEFAULT_PROJECT_ID, ownerKey: "" },
        { id: "p1", ownerKey: SOURCE },
      ],
      sessions: [{ id: "s1", ownerKey: OTHER, projectId: "p1" }],
    })).toThrow(/other owner/);
    expect(() => planOwnerTransfer({
      sourceOwnerKey: SOURCE,
      targetOwnerKey: TARGET,
      projects: [{ id: DEFAULT_PROJECT_ID, ownerKey: "" }],
      sessions: [{ id: "s1", ownerKey: OTHER, projectId: DEFAULT_PROJECT_ID }],
    })).toThrow(/no resources to transfer/);
    expect(() => planOwnerTransfer({
      sourceOwnerKey: SOURCE,
      targetOwnerKey: TARGET,
      projects: [
        { id: DEFAULT_PROJECT_ID, ownerKey: "" },
        { id: "p1", ownerKey: SOURCE },
        { id: "p2", ownerKey: OTHER },
      ],
      sessions: [{ id: "s1", ownerKey: SOURCE, projectId: "p2" }],
    })).toThrow(/owned by another owner/);
  });
});