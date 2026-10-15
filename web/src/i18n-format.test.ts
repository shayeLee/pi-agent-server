/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = `${dirname(fileURLToPath(import.meta.url))}/`;
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = `${dir}${name}`;
    if (statSync(path).isDirectory()) return sources(`${path}/`);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("single-source locale formatting", () => {
  it("formats numbers, dates and units only in i18n/format.ts, from the language object's locale", () => {
    // Language objects declare their locale; i18n/format.ts is the only consumer.
    const offenders = sources(root).filter(path => !path.includes("/i18n/"))
      .filter(path => /\bIntl\.|\.toLocale(?:String|DateString|TimeString)\(|["'](?:zh-CN|en-US)["']/.test(readFileSync(path, "utf8")));
    expect(offenders.map(path => path.slice(root.length))).toEqual([]);
    expect(readFileSync(`${root}i18n/format.ts`, "utf8")).not.toMatch(/["'](?:zh-CN|en-US)["']/);
  });
});
