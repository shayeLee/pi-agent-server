import assert from "node:assert/strict";
import net from "node:net";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Installed only inside this Playwright worker, never in the server/user environment.
export function isolateProjectDiscovery(root: string) {
  const selections: { provider: string; id: string; operation: string }[] = [];
  const blocked: string[] = [];
  const restores: (() => void)[] = [];
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  restores.push(() => { if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline; });
  const replace = (object: any, key: string, value: any) => {
    const original = object[key]; object[key] = value;
    restores.push(() => { object[key] = original; });
    return original;
  };
  const loopback = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  const deny = (host: string) => { blocked.push(host); throw new Error("fixture denied non-loopback network"); };
  const originalFetch = globalThis.fetch;
  replace(globalThis, "fetch", (input: any, init: any) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!loopback(url.hostname)) deny(url.hostname);
    return originalFetch(input, init);
  });
  const connect = net.Socket.prototype.connect;
  replace(net.Socket.prototype, "connect", function (this: net.Socket, ...args: any[]) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof options === "object" ? options.host ?? "localhost" : typeof args[1] === "string" ? args[1] : "localhost";
    if (!loopback(host)) deny(host);
    return (connect as any).apply(this, args);
  });
  const create = ModelRuntime.create;
  replace(ModelRuntime, "create", (options: any) => {
    assert(options.authPath.startsWith(root + "/"));
    assert(options.modelsPath.startsWith(root + "/"));
    return create.call(ModelRuntime, { ...options, allowModelNetwork: false, refreshOnCreate: false });
  });
  const proto = ModelRuntime.prototype;
  const fixture = (model: any) => model.provider === "native-fixture" && model.id === "offline";
  const getModel = proto.getModel;
  replace(proto, "getModel", function (this: ModelRuntime, provider: string, id: string) {
    selections.push({ provider, id, operation: "getModel" });
    assert.equal(provider, "native-fixture"); assert.equal(id, "offline");
    return getModel.call(this, provider, id);
  });
  for (const key of ["streamSimple", "stream"] as const) {
    const original = proto[key];
    replace(proto, key, function (this: ModelRuntime, model: any, ...args: any[]) {
      selections.push({ provider: model.provider, id: model.id, operation: key });
      assert(fixture(model), "non-fixture inference blocked before SDK stream");
      return (original as any).call(this, model, ...args);
    });
  }
  const hasAuth = proto.hasConfiguredAuth;
  replace(proto, "hasConfiguredAuth", function (this: ModelRuntime, provider: string) {
    return provider === "native-fixture" && hasAuth.call(this, provider);
  });
  for (const key of ["getModels", "getAvailableSnapshot"] as const) {
    const original = proto[key];
    replace(proto, key, function (this: ModelRuntime, ...args: any[]) { return (original as any).apply(this, args).filter(fixture); });
  }
  const available = proto.getAvailable;
  replace(proto, "getAvailable", async function (this: ModelRuntime, ...args: any[]) {
    return (await (available as any).apply(this, args)).filter(fixture);
  });
  return { selections, blocked, restore: () => restores.reverse().forEach(restore => restore()) };
}
