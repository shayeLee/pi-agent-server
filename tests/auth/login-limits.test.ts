import { describe, expect, it } from "vitest";
import { LoginBackoff, ScryptGate } from "../../src/auth/login-limits.js";

describe("ScryptGate", () => {
  it("lets two computations run at once and frees a slot on release", () => {
    const gate = new ScryptGate();
    const a = gate.tryAcquire();
    const b = gate.tryAcquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(gate.tryAcquire()).toBeNull();
    a!();
    a!(); // releasing twice frees one slot only
    expect(gate.tryAcquire()).not.toBeNull();
    expect(gate.tryAcquire()).toBeNull();
  });
});

describe("LoginBackoff", () => {
  it("backs off 1s, 2s, 4s … up to 5 minutes, and clears on success", () => {
    const backoff = new LoginBackoff();
    let now = 1_000_000;
    expect(backoff.retryAfterSeconds("k", now)).toBe(0);
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      backoff.recordFailure("k", now);
      waits.push(backoff.retryAfterSeconds("k", now));
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]);
    now += 300_000;
    expect(backoff.retryAfterSeconds("k", now)).toBe(0);
    backoff.clear("k");
    backoff.recordFailure("k", now);
    expect(backoff.retryAfterSeconds("k", now)).toBe(1);
  });

  it("keeps keys apart, forgets a key after 30 idle minutes, and holds at most 1000 keys", () => {
    const backoff = new LoginBackoff();
    const now = 5_000_000;
    backoff.recordFailure("a", now);
    expect(backoff.retryAfterSeconds("b", now)).toBe(0);
    for (let i = 0; i < 5; i++) backoff.recordFailure("idle", now);
    expect(backoff.retryAfterSeconds("idle", now + 30 * 60_000 + 1)).toBe(0);
    backoff.recordFailure("idle", now + 30 * 60_000 + 2);
    expect(backoff.retryAfterSeconds("idle", now + 30 * 60_000 + 2)).toBe(1); // counting started over

    const full = new LoginBackoff();
    for (let i = 0; i < 1001; i++) full.recordFailure(`k${i}`, now);
    expect(full.retryAfterSeconds("k0", now)).toBe(0);
    expect(full.retryAfterSeconds("k1000", now)).toBe(1);
  });
});
