// WP4B（方案 A）file-ops CLI 参数契约：只读 planner；--apply 立即 fail-closed、
// 无确认词绕过、旧执行器参数一律拒绝；错误输出脱敏（无绝对路径/URL/凭证）。

import { describe, expect, it } from "vitest";
import {
  FILE_OPS_APPLY_UNAVAILABLE,
  parseFileOpsArgs,
  readOnlyPostgresUrl,
  redactFileOpsError,
} from "../../scripts/file-ops.js";

describe("parseFileOpsArgs（WP4B planner CLI）", () => {
  it("默认（无模式参数）视为 dry-run：只读", () => {
    expect(parseFileOpsArgs(["run"])).toEqual({ mode: "default" });
    expect(parseFileOpsArgs(["--", "run"])).toEqual({ mode: "default" });
    expect(parseFileOpsArgs(["run", "--dry-run"])).toEqual({ mode: "dry-run" });
  });

  it("--apply 立即 fail-closed：未实现，且不存在任何确认词可以绕过", () => {
    expect(() => parseFileOpsArgs(["run", "--apply"])).toThrow(FILE_OPS_APPLY_UNAVAILABLE);
    expect(() => parseFileOpsArgs(["run", "--apply"])).toThrow(/未实现/);
    expect(() => parseFileOpsArgs(["run", "--apply"])).toThrow(/只读/);
    // 旧 WP4B 确认词/维护窗口词不再被接受（无绕过路径）。
    expect(() => parseFileOpsArgs(["run", "--apply", "--confirm-maintenance", "EXECUTE_FILE_OPERATIONS", "--maintenance-window", "CONFIRMED"]))
      .toThrow(FILE_OPS_APPLY_UNAVAILABLE);
    expect(() => parseFileOpsArgs(["run", "--confirm-maintenance"])).toThrow(/未知参数/);
    expect(() => parseFileOpsArgs(["run", "--maintenance-window", "CONFIRMED"])).toThrow(/未知参数/);
  });

  it("旧执行器参数（limit/backoff/lease/remove-empty-parents）一律拒绝", () => {
    for (const args of [
      ["run", "--limit", "5"],
      ["run", "--max-attempts", "5"],
      ["run", "--backoff-base-ms", "1000"],
      ["run", "--backoff-cap-ms", "60000"],
      ["run", "--lease-ms", "60000"],
      ["run", "--remove-empty-parents", "true"],
    ]) {
      expect(() => parseFileOpsArgs(args)).toThrow(/未知参数/);
    }
  });

  it("未知参数与重复 flag 拒绝（退出码 2 语义由 runFileOpsCli 保证）", () => {
    expect(() => parseFileOpsArgs(["run", "--frobnicate"])).toThrow("用法：未知参数");
    // 不回显原始 argv：未知值可能含路径/凭证，绝不出现在错误消息里。
    expect(() => parseFileOpsArgs(["run", "--frobnicate"])).not.toThrow(/frobnicate/);
    expect(() => parseFileOpsArgs(["run", "/Users/alice/secret"])).not.toThrow(/Users|alice|secret/);
    expect(() => parseFileOpsArgs(["run", "--dry-run", "--dry-run"])).toThrow(/只能出现一次/);
    expect(() => parseFileOpsArgs(["bogus"])).toThrow(/用法/);
    expect(() => parseFileOpsArgs([])).toThrow(/用法/);
  });
});

describe("redactFileOpsError（WP4B planner CLI 脱敏）", () => {
  it("用法消息原样保留，其余只暴露稳定类别（无路径/URL/凭证）", () => {
    expect(redactFileOpsError(new Error("用法：未知参数 --frobnicate"))).toBe("用法：未知参数 --frobnicate");
    const secret = "/Users/alice/private-data/pi-agent-server.db";
    const url = "postgresql://user:password@host:5432/db";
    expect(redactFileOpsError(new Error(`sqlite error at ${secret}`))).toBe("file-ops error: FILE_OPS_FAILED");
    expect(redactFileOpsError(new Error(`connection ${url} failed`))).toBe("file-ops error: FILE_OPS_FAILED");
    expect(redactFileOpsError(new Error("unexpected"))).toBe("file-ops error: FILE_OPS_FAILED");
  });
});

describe("readOnlyPostgresUrl（PG planner 会话只读强制）", () => {
  it("追加 default_transaction_read_only=on，保留既有参数", () => {
    const url = readOnlyPostgresUrl("postgresql://user:pass@host:5432/db");
    expect(url).toContain("options=");
    expect(decodeURIComponent(url)).toContain("default_transaction_read_only=on");
    expect(url).toContain("//user:pass@");
  });

  it("原 URL 已含 options 时拒绝（fail-closed，不降级为可写连接）", () => {
    expect(() => readOnlyPostgresUrl("postgresql://user:pass@host:5432/db?options=-c%20search_path%3Dx")).toThrow(/options/);
  });
});