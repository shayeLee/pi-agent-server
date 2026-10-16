// Project path suggestions for `@` references in the composer. Names only: no contents, no stat
// details. The root is the owning session's frozen project cwd, checked like file preview.
import { execFile } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ProjectFileEntry, ProjectFileSearch } from "../shared/commands.js";
import { sensitiveName, type PreviewRoot } from "./session-file-preview.js";

export const FILE_SEARCH_LIMIT = 20;
const MAX_QUERY_LENGTH = 256;
const MAX_LISTED_FILES = 50_000;
const LIST_CACHE_MS = 5_000;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
/** OS litter that is never worth referencing (git projects already ignore it). */
const SKIPPED_FILES = new Set([".DS_Store", "Thumbs.db"]);

export class FileSearchError extends Error { constructor(readonly code: "FILE_SEARCH_INVALID_QUERY" | "FILE_SEARCH_FORBIDDEN") { super(code); } }

type Listing = { files: string[]; truncated: boolean };

/** Git-tracked and untracked-but-not-ignored files: the same set Pi's `fd` honours via .gitignore. */
function gitFiles(root: string): Promise<Listing | null> {
  return new Promise(resolve => {
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, timeout: 5_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        const files = [...new Set(stdout.split("\0").filter(Boolean))];
        resolve({ files: files.slice(0, MAX_LISTED_FILES), truncated: files.length > MAX_LISTED_FILES });
      });
  });
}

/** Bounded walk for projects outside git. Symlinks are listed, never followed. */
function walkFiles(root: string): Listing {
  const files: string[] = [];
  const queue = [""];
  while (queue.length) {
    const dir = queue.shift()!;
    let entries;
    try { entries = readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) queue.push(relative); continue; }
      if (SKIPPED_FILES.has(entry.name)) continue;
      files.push(relative);
      if (files.length >= MAX_LISTED_FILES) return { files, truncated: true };
    }
  }
  return { files, truncated: false };
}

function checkRoot(root: PreviewRoot): void {
  try {
    const node = lstatSync(root.cwd);
    if (realpathSync(root.cwd) !== root.cwd || node.isSymbolicLink() || !node.isDirectory() || node.dev !== root.dev || node.ino !== root.ino) throw new Error();
  } catch { throw new FileSearchError("FILE_SEARCH_FORBIDDEN"); }
}

/** Files plus every ancestor directory, without sensitive names anywhere in the path. */
function entriesOf(listing: Listing): ProjectFileEntry[] {
  const directories = new Set<string>();
  const entries: ProjectFileEntry[] = [];
  for (const file of listing.files) {
    const parts = file.split("/");
    if (parts.some(part => sensitiveName.test(part))) continue;
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
    entries.push({ path: file, kind: "file" });
  }
  return [...[...directories].map(dir => ({ path: dir, kind: "directory" as const })), ...entries];
}

function subsequence(query: string, text: string): boolean {
  let index = 0;
  for (const char of text) if (char === query[index]) index++;
  return index === query.length;
}

/** Pi's ranking: exact name, name prefix, name substring, path substring, then fuzzy path. */
function score(entry: ProjectFileEntry, query: string): number {
  const full = entry.path.toLowerCase();
  const name = full.slice(full.lastIndexOf("/") + 1);
  const value = query.includes("/")
    ? full === query ? 100 : full.startsWith(query) ? 80 : full.includes(query) ? 50 : subsequence(query, full) ? 10 : 0
    : name === query ? 100 : name.startsWith(query) ? 80 : name.includes(query) ? 50 : full.includes(query) ? 30 : subsequence(query, full) ? 10 : 0;
  return value > 0 && entry.kind === "directory" ? value + 10 : value;
}

const depth = (entry: ProjectFileEntry) => entry.path.split("/").length;

export function createProjectFileSearch(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; listing: Promise<{ entries: ProjectFileEntry[]; truncated: boolean }> }>();
  const list = (root: string) => {
    const hit = cache.get(root);
    if (hit && now() - hit.at < LIST_CACHE_MS) return hit.listing;
    const listing = gitFiles(root).then(files => files ?? walkFiles(root)).then(files => ({ entries: entriesOf(files), truncated: files.truncated }));
    cache.set(root, { at: now(), listing });
    listing.catch(() => cache.delete(root));
    return listing;
  };
  return async (root: PreviewRoot, rawQuery: unknown): Promise<ProjectFileSearch> => {
    if (rawQuery !== undefined && (typeof rawQuery !== "string" || rawQuery.length > MAX_QUERY_LENGTH || rawQuery.includes("\0"))) {
      throw new FileSearchError("FILE_SEARCH_INVALID_QUERY");
    }
    checkRoot(root);
    const query = (rawQuery ?? "").trim().replace(/^@/, "").replace(/\\/g, "/").toLowerCase();
    const { entries, truncated } = await list(root.cwd);
    const ranked = query
      ? entries.map(entry => ({ entry, value: score(entry, query) })).filter(item => item.value > 0)
        .sort((a, b) => b.value - a.value || depth(a.entry) - depth(b.entry) || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
        .map(item => item.entry)
      : entries.filter(entry => depth(entry) === 1)
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) || a.path.localeCompare(b.path));
    return { entries: ranked.slice(0, FILE_SEARCH_LIMIT), truncated };
  };
}
