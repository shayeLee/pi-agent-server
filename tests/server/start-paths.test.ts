// startServer 默认路径解析的单测：只测纯函数 resolveServerPaths，不启动服务。
// 覆盖：默认 authPath = $HOME/.pi/agent/auth.json、其余路径默认值、显式覆盖优先级。

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { resolveServerPaths } from "../../src/server/start.js";

describe("resolveServerPaths 默认路径解析", () => {
  it("全部未设置：authPath 默认个人凭证，其余路径落在 cwd 下", () => {
    const cwd = process.cwd();
    const paths = resolveServerPaths({});
    expect(paths.cwd).toBe(cwd);
    expect(paths.dataDir).toBe(cwd);
    expect(paths.agentDir).toBe(path.join(cwd, ".pi-agent"));
    expect(paths.modelsPath).toBe(path.join(cwd, ".pi-agent", "models.json"));
    // 核心断言：凭证默认指向个人 $HOME/.pi/agent/auth.json（与 pi CLI 共用）
    expect(paths.authPath).toBe(path.join(homedir(), ".pi", "agent", "auth.json"));
    expect(paths.dbPath).toBe(path.join(cwd, "pi-agent-server.db"));
  });

  it("显式 dataDir：agentDir/modelsPath/dbPath 跟随 dataDir，authPath 仍默认个人凭证", () => {
    const dataDir = "/tmp/srv-data";
    const paths = resolveServerPaths({ dataDir });
    expect(paths.dataDir).toBe(dataDir);
    expect(paths.agentDir).toBe(path.join(dataDir, ".pi-agent"));
    expect(paths.modelsPath).toBe(path.join(dataDir, ".pi-agent", "models.json"));
    expect(paths.dbPath).toBe(path.join(dataDir, "pi-agent-server.db"));
    expect(paths.authPath).toBe(path.join(homedir(), ".pi", "agent", "auth.json"));
  });

  it("显式 authPath：覆盖默认个人凭证路径", () => {
    const authPath = "/opt/creds/auth.json";
    const paths = resolveServerPaths({ authPath });
    expect(paths.authPath).toBe(authPath);
  });

  it("显式 agentDir：agentDir 与 modelsPath 生效，不跟随 dataDir", () => {
    const agentDir = "/opt/agent";
    const paths = resolveServerPaths({ dataDir: "/tmp/srv-data", agentDir });
    expect(paths.agentDir).toBe(agentDir);
    expect(paths.modelsPath).toBe(path.join(agentDir, "models.json"));
    // dataDir 只影响未显式设置的 agentDir 默认值
    expect(paths.dbPath).toBe(path.join("/tmp/srv-data", "pi-agent-server.db"));
  });

  it("显式 dbPath：覆盖默认 dataDir/pi-agent-server.db", () => {
    const dbPath = "/opt/data/custom.db";
    const paths = resolveServerPaths({ dbPath });
    expect(paths.dbPath).toBe(dbPath);
  });

  it("全部显式：各自独立生效，互不干扰", () => {
    const cwd = "/work/proj";
    const dataDir = "/srv/data";
    const agentDir = "/srv/agent";
    const authPath = "/srv/creds.json";
    const dbPath = "/srv/db.sqlite";
    const paths = resolveServerPaths({ cwd, dataDir, agentDir, authPath, dbPath });
    expect(paths).toEqual({
      cwd,
      dataDir,
      agentDir,
      modelsPath: path.join(agentDir, "models.json"),
      authPath,
      dbPath,
    });
  });
});
