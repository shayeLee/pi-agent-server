import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { readBridgeConfig } from "../../src/claude-bridge/config.js";
import { StdioServerTransport } from "../../src/claude-bridge/stdio-transport.js";

test("reads the backend, label, web link and project list", () => {
  const config = readBridgeConfig({
    PI_BRIDGE_BASE_URL: "http://127.0.0.1:8080/",
    PI_BRIDGE_WEB_URL: "http://127.0.0.1:5173",
    PI_BRIDGE_PROJECTS: " p1, ,p2 ",
    PI_BRIDGE_WAIT_SECONDS: "30",
  });
  expect(config).toEqual({
    baseUrl: "http://127.0.0.1:8080", token: "", label: "127.0.0.1:8080", webUrl: "http://127.0.0.1:5173", waitMs: 30_000, projects: ["p1", "p2"],
  });
});

test("rejects a missing or non-http backend and a bad wait", () => {
  expect(() => readBridgeConfig({})).toThrow(/PI_BRIDGE_BASE_URL/);
  expect(() => readBridgeConfig({ PI_BRIDGE_BASE_URL: "file:///etc" })).toThrow(/http/);
  expect(() => readBridgeConfig({ PI_BRIDGE_BASE_URL: "http://x", PI_BRIDGE_WAIT_SECONDS: "0" })).toThrow(/PI_BRIDGE_WAIT_SECONDS/);
});

test("reads the token from a file and refuses an empty one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-bridge-config-"));
  const tokenFile = path.join(dir, "token");
  writeFileSync(tokenFile, "secret\n");
  expect(readBridgeConfig({ PI_BRIDGE_BASE_URL: "http://x", PI_BRIDGE_TOKEN_FILE: tokenFile }).token).toBe("secret");
  writeFileSync(tokenFile, "  \n");
  expect(() => readBridgeConfig({ PI_BRIDGE_BASE_URL: "http://x", PI_BRIDGE_TOKEN_FILE: tokenFile })).toThrow(/空文件/);
});

test("stdio transport splits lines across chunks and reports bad ones", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new StdioServerTransport(input, output);
  const methods: string[] = [];
  const errors: Error[] = [];
  transport.onMessage((message) => { if ("method" in message) methods.push(message.method); });
  transport.onError((error) => errors.push(error));
  await transport.start();

  input.write('{"jsonrpc":"2.0","id":1,"meth');
  input.write('od":"ping"}\nnot json\n\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  expect(methods).toEqual(["ping", "notifications/initialized"]);
  expect(errors).toHaveLength(1);

  await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
  expect(String(output.read())).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
});
