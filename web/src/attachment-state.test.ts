import { describe, expect, it } from "vitest";
import { classifyFile, validateSelection, type UnsentAttachment } from "./attachment-state.js";

function chosen(name: string, size: number, type = "application/octet-stream") {
  return { name, size, type };
}

function readyFile(index: number, size: number): UnsentAttachment {
  return { localId: String(index), name: `file-${index}.txt`, size, mediaType: "text/plain", kind: "text", status: "ready" };
}

describe("attachment selection", () => {
  it("supports OOXML but explicitly refuses old Office, archives and executables", () => {
    expect(classifyFile(chosen("report.docx", 10))).toEqual({ kind: "docx" });
    expect(classifyFile(chosen("table.xlsx", 10))).toEqual({ kind: "xlsx" });
    expect(classifyFile(chosen("slides.pptx", 10))).toEqual({ kind: "pptx" });
    for (const name of ["report.doc", "table.xls", "slides.ppt", "data.zip", "program.exe"]) {
      expect(classifyFile(chosen(name, 1))).toHaveProperty("error");
    }
  });

  it("checks 20 MiB each, five files, and 50 MiB total without widening image limits", () => {
    const mib = 1024 * 1024;
    expect(validateSelection([], chosen("large.pdf", 20 * mib + 1))).toHaveProperty("error");
    expect(validateSelection(Array.from({ length: 5 }, (_, index) => readyFile(index, 1)), chosen("sixth.txt", 1))).toHaveProperty("error");
    expect(validateSelection([readyFile(0, 18 * mib), readyFile(1, 18 * mib)], chosen("third.txt", 15 * mib))).toHaveProperty("error");
    expect(validateSelection([], chosen("image.png", 4 * mib + 1, "image/png"))).toHaveProperty("error");
    expect(validateSelection([], chosen("image.png", 4 * mib, "image/png"))).toEqual({ kind: "image" });
  });
});
