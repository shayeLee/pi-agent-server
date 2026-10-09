import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

/** Explicit startup snapshot; never uses agent/project cwd or expands '~'. */
export function readAppendSystemPromptFile(configured: string | undefined): string | undefined {
  if (!configured?.trim()) return undefined;
  const file = resolve(process.cwd(), configured.trim());
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    if (!fstatSync(fd).isFile()) {
      throw new Error("not a regular file");
    }
    // Fatal decoding rejects malformed UTF-8 rather than silently inserting replacement chars.
    // ignoreBOM preserves the original text, including a leading UTF-8 BOM.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(fd));
    return text.trim() ? text : undefined;
  } catch {
    // Do not propagate arbitrary error text/cause or any file contents.
    throw new Error(`PI_APPEND_SYSTEM_FILE: cannot read regular UTF-8 file: ${file}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
