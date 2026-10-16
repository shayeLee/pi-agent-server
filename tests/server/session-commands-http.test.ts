import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../../src/server/app.js";
import { DEFAULT_PROJECT_ID } from "../../src/shared/project-identity.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { SessionCommandInput, SessionCommandResult } from "../../src/shared/commands.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";

class CommandAdapter extends MockAgentAdapter {
  failWith?: string;
  async runCommand(input: SessionCommandInput): Promise<SessionCommandResult> {
    if (this.failWith) throw new Error(this.failWith);
    return input.command === "compact" ? { command: "compact", tokensBefore: 10, tokensAfter: 2 }
      : { command: "reload", contextFiles: 1, promptTemplates: 0, skills: 2, extensions: 3 };
  }
}

async function setup(adapter: MockAgentAdapter) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-commands-http-"));
  const { projects, sessions } = await makeInitializedMemoryDb({ cwd: dir });
  const app = buildApp({ sessions, projects, defaultProjectCwd: dir, ipAccess: makeTestIpAccess(), createAdapter: async () => adapter });
  const created = await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "10.0.0.1", headers: { "content-type": "application/json" }, payload: "{}" });
  const id = created.json().id as string;
  const post = (payload: unknown, remoteAddress = "10.0.0.1") => app.inject({ method: "POST", url: `/v1/sessions/${id}/commands`, remoteAddress,
    headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
  return { app, id, post, dir };
}

describe("session command routes", () => {
  it("runs compact and reload and maps failures to stable statuses", async () => {
    const adapter = new CommandAdapter();
    const { app, post } = await setup(adapter);
    try {
      expect((await post({ command: "compact", args: "keep it" })).json()).toEqual({ command: "compact", tokensBefore: 10, tokensAfter: 2 });
      expect((await post({ command: "reload" })).json()).toEqual({ command: "reload", contextFiles: 1, promptTemplates: 0, skills: 2, extensions: 3 });
      expect((await post({ command: "logout" })).statusCode).toBe(400);
      expect((await post({})).statusCode).toBe(400);
      adapter.failWith = "Nothing to compact";
      const failed = await post({ command: "compact" });
      expect(failed.statusCode).toBe(422);
      expect(failed.json().message).toBe("Nothing to compact");
      expect((await post({ command: "reload" }, "10.0.0.2")).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("reports agents without host commands as not implemented", async () => {
    const { app, post } = await setup(new MockAgentAdapter());
    try {
      expect((await post({ command: "compact" })).statusCode).toBe(501);
    } finally { await app.close(); }
  });

  it("serves the menu and path suggestions only for a session with a frozen project root", async () => {
    const { app, id } = await setup(new CommandAdapter());
    try {
      for (const url of [`/v1/sessions/${id}/commands`, `/v1/sessions/${id}/files?query=src`]) {
        expect((await app.inject({ method: "GET", url, remoteAddress: "10.0.0.1" })).statusCode).toBe(404);
      }
    } finally { await app.close(); }
  });

  it("serves a draft's project menus without host commands, and only for usable projects", async () => {
    const { app, dir } = await setup(new CommandAdapter());
    writeFileSync(path.join(dir, "notes.md"), "x");
    const get = (url: string) => app.inject({ method: "GET", url, remoteAddress: "10.0.0.1" });
    try {
      expect((await get(`/v1/projects/${DEFAULT_PROJECT_ID}/commands`)).json()).toEqual({ commands: [] });
      expect((await get(`/v1/projects/${DEFAULT_PROJECT_ID}/files?query=notes`)).json().entries).toEqual([{ path: "notes.md", kind: "file" }]);
      for (const url of ["/v1/projects/missing/commands", "/v1/projects/missing/files"]) expect((await get(url)).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
