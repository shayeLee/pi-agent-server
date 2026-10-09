import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  validateAttachment,
  type AttachmentKind,
} from "../../src/attachments/file-policy.js";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, string | Buffer>, options: { readonly symlink?: string; readonly corruptCrc?: string } = {}): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const compressed = deflateRawSync(raw);
    const checksum = (crc32(raw) ^ (options.corruptCrc === name ? 1 : 0)) >>> 0;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    if (options.symlink === name) central.writeUInt32LE((0o120777 << 16) >>> 0, 38);
    nameBytes.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

const officeFixtures: Record<"docx" | "xlsx" | "pptx", Record<string, string>> = {
  docx: {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
  },
  xlsx: {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheets/></x:workbook>',
  },
  pptx: {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    "ppt/presentation.xml": '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>',
  },
};

function inspect(kind: AttachmentKind, originalName: string, bytes: Uint8Array) {
  return validateAttachment({ kind, originalName, bytes });
}

describe("attachment byte policy", () => {
  it("accepts UTF-8 text and calculates the digest over the exact bytes", () => {
    const bytes = Buffer.from("hello, 世界\n");
    const result = inspect("text", "notes.txt", bytes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes).toEqual(bytes);
      expect(result.size).toBe(bytes.length);
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("parses JSON syntax while keeping text and code as UTF-8 content", () => {
    expect(inspect("json", "data.json", Buffer.from('{"ok":true,"items":[1,null]}'))).toMatchObject({ ok: true, kind: "json" });
    for (const invalid of ["{broken}", "[1,]", "undefined", "{\"duplicate\":1,,}"]) {
      expect(inspect("json", "data.json", Buffer.from(invalid))).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    }
    expect(inspect("code", "source.ts", Buffer.from("not valid JSON {"))).toMatchObject({ ok: true, kind: "code" });
  });

  it("rejects malformed UTF-8, NUL, executable signatures, and archives masquerading as text", () => {
    expect(inspect("text", "notes.txt", Buffer.from([0xc3, 0x28]))).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("code", "source.ts", Buffer.from([0x61, 0x00, 0x62]))).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("text", "program.txt", Buffer.from("MZ\x00\x00"))).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
    expect(inspect("text", "bundle.txt", zip({ "plain.txt": "ordinary zip" }))).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
    expect(inspect("text", "photo.png", Buffer.from("text"))).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
  });

  it("enforces the 20 MiB item limit", () => {
    const oversized = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61);
    expect(inspect("text", "large.txt", oversized)).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("requires PDF signature and terminal EOF marker, independent of its extension", () => {
    expect(inspect("pdf", "report.pdf", Buffer.from("plain text"))).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("pdf", "report.pdf", Buffer.from("%PDF-1.7\nbody\n%%EOF\n"))).toMatchObject({ ok: true, kind: "pdf" });
    expect(inspect("pdf", "report.pdf", Buffer.from("%PDF-1.7\nbody\n%%EOF\ntrailing"))).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("text", "report.txt", Buffer.from("%PDF-1.7\n%%EOF"))).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
  });

  it.each(["docx", "xlsx", "pptx"] as const)("accepts structurally checked %s and rejects plain/forged ZIPs", (kind) => {
    const valid = zip(officeFixtures[kind]);
    expect(inspect(kind, `file.${kind}`, valid)).toMatchObject({ ok: true, kind });
    expect(inspect(kind, `file.${kind}`, zip({ "plain.txt": "ordinary zip" }))).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    const mainPath = kind === "docx" ? "word/document.xml" : kind === "xlsx" ? "xl/workbook.xml" : "ppt/presentation.xml";
    expect(inspect(kind, `file.${kind}`, zip({ ...officeFixtures[kind], [mainPath]: "wrong target content" })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    const commentedForgery = Object.fromEntries(Object.entries(officeFixtures[kind]).map(([name, content]) => [name, `<!--${content}-->`]));
    expect(inspect(kind, `file.${kind}`, zip(commentedForgery))).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
  });

  it("rejects Office ZIP bombs, CRC mismatches, symlinks, macros, and embedded payloads", () => {
    const valid = officeFixtures.docx;
    const bomb = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    expect(inspect("docx", "file.docx", zip({ ...valid, "custom/data.xml": bomb })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    const fiveMiB = Buffer.alloc(5 * 1024 * 1024, 0x62);
    expect(inspect("docx", "file.docx", zip({ ...valid, "custom/a.xml": fiveMiB, "custom/b.xml": fiveMiB, "custom/c.xml": fiveMiB, "custom/d.xml": fiveMiB })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("docx", "file.docx", zip({ ...valid, "word/extra.xml": "checked" }, { corruptCrc: "word/extra.xml" })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("docx", "file.docx", zip({ ...valid, "word/link.xml": "target" }, { symlink: "word/link.xml" })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("docx", "file.docx", zip({ ...valid, "word/vbaProject.bin": "macro" })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    const macroContentTypes = valid["[Content_Types].xml"]!.replace("</Types>", '<Override PartName="/custom/macros.xml" ContentType="application/vnd.ms-office.vbaProject"/></Types>');
    expect(inspect("docx", "file.docx", zip({ ...valid, "[Content_Types].xml": macroContentTypes })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("docx", "file.docx", zip({ ...valid, "word/embeddings/object.xml": "embedded" })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
  });

  it("bounds Office XML tag length and node count without scanning unbounded tags", () => {
    const oversizedTag = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override ${"a".repeat(9 * 1024)}="x"/></Types>`;
    expect(inspect("docx", "file.docx", zip({ ...officeFixtures.docx, "[Content_Types].xml": oversizedTag })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    const crowdedMain = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + "<w:x/>".repeat(20_001) + "</w:document>";
    expect(inspect("docx", "file.docx", zip({ ...officeFixtures.docx, "word/document.xml": crowdedMain })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    const hugeMain = Buffer.concat([
      Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'),
      Buffer.alloc(ATTACHMENT_MAX_BYTES, 0x61),
      Buffer.from("</w:document>"),
    ]);
    expect(inspect("docx", "file.docx", zip({ ...officeFixtures.docx, "word/document.xml": hugeMain })))
      .toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
  });

  it("does not trust a matching Office extension when the selected type or contents disagree", () => {
    expect(inspect("docx", "renamed.docx", zip(officeFixtures.xlsx))).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("xlsx", "renamed.docx", zip(officeFixtures.xlsx))).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(inspect("docx", "legacy.doc", Buffer.from("legacy"))).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
  });

  it("rejects path traversal, reserved names, and executable/archive suffixes", () => {
    for (const name of ["../secret.txt", "folder\\file.txt", "/absolute.txt", "C:secret.txt", "..", "CON.txt", "safe%2fpath.txt"]) {
      expect(inspect("text", name, Buffer.from("text"))).toMatchObject({ ok: false, code: "INVALID_NAME" });
    }
    expect(inspect("code", "run.exe", Buffer.from("const x = 1"))).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
    expect(inspect("text", "archive.zip", Buffer.from("text"))).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
  });
});
