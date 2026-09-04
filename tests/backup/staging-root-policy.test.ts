import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertStagingAncestorStat,
  createPlaintextStaging,
  defaultPlaintextStagingRoot,
  openPlaintextStaging,
} from "../../src/backup/backup-core.js";

// The default plaintext staging root is the per-user private config root
// under homedir(). The mock redirects homedir to a crafted per-test private
// base, so the untouched default path is exercised against a controlled,
// fully trusted ancestor chain.
const fakeHome = vi.hoisted(() => ({ current: "" as string }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => (fakeHome.current || actual.homedir()) };
});

const cleanups: string[] = [];
let savedStagingEnv: string | undefined;
beforeEach(() => {
  // The default-root tests must exercise the true default (mocked homedir);
  // the run-wide PI_BACKUP_STAGING_ROOT hermetic override is removed here and
  // restored afterwards.
  savedStagingEnv = process.env.PI_BACKUP_STAGING_ROOT;
  delete process.env.PI_BACKUP_STAGING_ROOT;
});
afterEach(() => {
  fakeHome.current = "";
  if (savedStagingEnv !== undefined) process.env.PI_BACKUP_STAGING_ROOT = savedStagingEnv;
  else delete process.env.PI_BACKUP_STAGING_ROOT;
  for (const directory of cleanups.splice(0)) {
    // Two passes: restore ALL write/sticky bits before ANY removal.
    try { chmodSync(directory, 0o700); } catch { /* already writable */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A fresh trusted per-user "home" (0700, current user, no sticky bit). */
function makeFakeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "pi-staging-home-"));
  chmodSync(home, 0o700);
  cleanups.push(home);
  fakeHome.current = home;
  return home;
}

/**
 * Backup root honoring the overlap contract: the staging candidate must stay
 * outside the backup root (home/store/backups) AND its parent (home/store).
 */
function backupRootOf(home: string): string {
  return path.join(home, "store", "backups");
}

describe("default plaintext staging root (private per-user config root, no OS temp dir)", () => {
  it("creates a current-user 0700 config staging root and a 0700 staging child", () => {
    const home = makeFakeHome();
    const staging = createPlaintextStaging(undefined, backupRootOf(home));
    cleanups.push(staging);
    // The default root is exactly the per-user Application Support staging root.
    expect(defaultPlaintextStagingRoot()).toBe(path.join(home, "Library", "Application Support", "pi-agent-server-backup-staging"));
    const root = path.dirname(staging);
    // The staging root is the default config root (mkdtemp runs on its
    // realpath canonicalization; on macOS that resolves /var → /private/var).
    expect(root).toBe(realpathSync(path.join(home, "Library", "Application Support", "pi-agent-server-backup-staging")));
    const rootStat = statSync(root);
    expect(rootStat.mode & 0o777).toBe(0o700);
    expect(path.basename(staging)).toMatch(/^\.pi-agent-backup-staging-/);
    expect(statSync(staging).mode & 0o777).toBe(0o700);
    expect(readdirSync(staging)).toEqual([]);
  });

  it("reuses the existing default root across calls (no recreate, children accumulate)", () => {
    const home = makeFakeHome();
    const first = createPlaintextStaging(undefined, backupRootOf(home));
    const second = createPlaintextStaging(undefined, backupRootOf(home));
    cleanups.push(first, second);
    expect(path.dirname(first)).toBe(path.dirname(second));
    expect(readdirSync(path.dirname(first)).filter((name) => name.startsWith(".pi-agent-backup-staging-"))).toHaveLength(2);
  });

  it("rejects a group/world-writable ancestor in the default home chain", () => {
    const home = makeFakeHome();
    chmodSync(home, 0o773);
    try {
      expect(() => createPlaintextStaging(undefined, backupRootOf(home)))
        .toThrow(/plaintext staging ancestor must not be group\/world writable/);
      // Nothing was staged: the created root was removed again.
      expect(existsSync(defaultPlaintextStagingRoot())).toBe(false);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  it("rejects a STICKY ancestor even when it is otherwise private (shared-surface ban)", () => {
    const home = makeFakeHome();
    chmodSync(home, 0o1700);
    try {
      expect(() => createPlaintextStaging(undefined, backupRootOf(home)))
        .toThrow(/plaintext staging ancestor must not be a sticky \(shared\) directory/);
      expect(existsSync(defaultPlaintextStagingRoot())).toBe(false);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  it("rejects a sticky world-writable ancestor deep in the default chain", () => {
    const home = makeFakeHome();
    const applicationSupportDir = path.join(home, "Library", "Application Support");
    mkdirSync(applicationSupportDir, { recursive: true, mode: 0o700 });
    chmodSync(applicationSupportDir, 0o1777);
    try {
      expect(() => createPlaintextStaging(undefined, backupRootOf(home)))
        .toThrow(/plaintext staging ancestor must not be a sticky \(shared\) directory/);
      expect(existsSync(defaultPlaintextStagingRoot())).toBe(false);
    } finally {
      chmodSync(applicationSupportDir, 0o700);
    }
  });
});

describe("staging ancestor component policy (unit-level)", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const stat = (mode: number, ownerUid: number) => ({ isDirectory: () => true, uid: ownerUid, mode });

  it("accepts the current user and root, non-sticky, non-group/world-writable directories", () => {
    expect(() => assertStagingAncestorStat(stat(0o700, uid), "ancestor")).not.toThrow();
    expect(() => assertStagingAncestorStat(stat(0o755, uid), "ancestor")).not.toThrow();
    expect(() => assertStagingAncestorStat(stat(0o755, 0), "ancestor")).not.toThrow();
  });

  it("rejects third-party-owned ancestors (the classic /tmp owner)", () => {
    expect(() => assertStagingAncestorStat(stat(0o755, uid + 1234), "ancestor"))
      .toThrow(/plaintext staging ancestor must be owned by the current user or root/);
  });

  it("rejects sticky ancestors regardless of writability", () => {
    expect(() => assertStagingAncestorStat(stat(0o1777, uid), "ancestor"))
      .toThrow(/plaintext staging ancestor must not be a sticky \(shared\) directory/);
    expect(() => assertStagingAncestorStat(stat(0o1700, uid), "ancestor"))
      .toThrow(/plaintext staging ancestor must not be a sticky \(shared\) directory/);
  });

  it("rejects group/world-writable ancestors", () => {
    expect(() => assertStagingAncestorStat(stat(0o777, uid), "ancestor"))
      .toThrow(/plaintext staging ancestor must not be group\/world writable/);
    expect(() => assertStagingAncestorStat(stat(0o770, uid), "ancestor"))
      .toThrow(/plaintext staging ancestor must not be group\/world writable/);
  });

  it("rejects non-directory components", () => {
    expect(() => assertStagingAncestorStat({ isDirectory: () => false, uid, mode: 0o644 }, "ancestor"))
      .toThrow(/plaintext staging ancestor is not a directory/);
  });
});

describe("explicit plaintext staging root (current-user 0700 + full trusted ancestor chain)", () => {
  it("accepts an explicit current-user 0700 root with a trusted ancestor chain", () => {
    const home = makeFakeHome();
    const root = path.join(home, "explicit-staging");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const staging = createPlaintextStaging(root, backupRootOf(home));
    cleanups.push(staging);
    expect(path.dirname(staging)).toBe(realpathSync(root));
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("rejects an explicit root that is not fully private (group/other bits)", () => {
    const home = makeFakeHome();
    const root = path.join(home, "explicit-staging");
    mkdirSync(root, { recursive: true, mode: 0o750 });
    chmodSync(root, 0o750);
    expect(() => createPlaintextStaging(root, backupRootOf(home)))
      .toThrow(/plaintext staging root must be private \(0700: no group\/other access\)/);
    // The unsafe root was left untouched and nothing was staged in it.
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects an explicit root that is sticky", () => {
    const home = makeFakeHome();
    const root = path.join(home, "explicit-staging");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o1700);
    expect(() => createPlaintextStaging(root, backupRootOf(home)))
      .toThrow(/plaintext staging root must not be a sticky \(shared\) directory/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects an explicit root with a group/world-writable ancestor in its FULL chain", () => {
    const home = makeFakeHome();
    const parent = path.join(home, "shared-parent");
    const root = path.join(parent, "staging");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o772);
    try {
      expect(() => createPlaintextStaging(root, backupRootOf(home)))
        .toThrow(/plaintext staging ancestor must not be group\/world writable/);
      expect(existsSync(root)).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it("rejects an explicit root with a sticky ancestor in its FULL chain", () => {
    const home = makeFakeHome();
    const parent = path.join(home, "shared-tmp-like");
    const root = path.join(parent, "staging");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o1777);
    try {
      expect(() => createPlaintextStaging(root, backupRootOf(home)))
        .toThrow(/plaintext staging ancestor must not be a sticky \(shared\) directory/);
      expect(existsSync(root)).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

describe("staging child FD retention and revalidation (rename substitution rejected)", () => {
  it("detects a rename+substitution of the staging directory before a sensitive operation", () => {
    const home = makeFakeHome();
    const handle = openPlaintextStaging(undefined, backupRootOf(home));
    cleanups.push(handle.path);
    // Revalidate passes while the verified inode is still at the path.
    expect(() => handle.revalidate()).not.toThrow();
    // Substitute the path: move the verified directory away and put a fresh,
    // identically-permissioned directory in its place (same owner, 0700).
    const substituted = `${handle.path}.substituted`;
    renameSync(handle.path, substituted);
    cleanups.push(substituted);
    mkdirSync(handle.path, { recursive: true, mode: 0o700 });
    // The fresh directory looks identical by stat — only the held directory
    // FD (dev+ino identity) proves the substitution.
    expect(statSync(handle.path).mode & 0o777).toBe(0o700);
    expect(() => handle.revalidate())
      .toThrow(/plaintext staging directory was renamed\/replaced before a sensitive operation/);
    handle.close();
  });

  it("detects a permission regression of the staging directory", () => {
    const home = makeFakeHome();
    const handle = openPlaintextStaging(undefined, backupRootOf(home));
    cleanups.push(handle.path);
    chmodSync(handle.path, 0o755);
    expect(() => handle.revalidate()).toThrow(/plaintext staging directory must stay private \(0700\)/);
    handle.close();
  });

  it("fails closed when the staging directory disappears", () => {
    const home = makeFakeHome();
    const handle = openPlaintextStaging(undefined, backupRootOf(home));
    const staged = handle.path;
    rmSync(staged, { recursive: true, force: true });
    expect(() => handle.revalidate()).toThrow(/plaintext staging directory was removed or replaced/);
    handle.close();
  });

  it("detects a symlink substitution of the staging path", () => {
    const home = makeFakeHome();
    const handle = openPlaintextStaging(undefined, backupRootOf(home));
    const substituted = `${handle.path}.substituted`;
    renameSync(handle.path, substituted);
    cleanups.push(substituted);
    symlinkSync(substituted, handle.path);
    expect(() => handle.revalidate()).toThrow(/plaintext staging directory was removed or replaced/);
    handle.close();
  });
});
