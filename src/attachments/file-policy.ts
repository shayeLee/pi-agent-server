import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export type AttachmentKind = "text" | "code" | "csv" | "json" | "pdf" | "docx" | "xlsx" | "pptx";

export interface AttachmentInput {
  /** Explicit caller-selected type; it is checked against bytes and filename, never trusted alone. */
  readonly kind: AttachmentKind;
  readonly originalName: string;
  readonly bytes: Uint8Array;
}

export type AttachmentValidationCode =
  | "INVALID_NAME"
  | "UNSUPPORTED_FORMAT"
  | "TYPE_MISMATCH"
  | "TOO_LARGE"
  | "INVALID_CONTENT";

export interface ValidatedAttachment {
  readonly ok: true;
  readonly kind: AttachmentKind;
  readonly originalName: string;
  /** Immutable snapshot of the exact bytes that were checked. */
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
}

export interface AttachmentValidationFailure {
  readonly ok: false;
  readonly code: AttachmentValidationCode;
  readonly message: string;
}

export type AttachmentValidationResult = ValidatedAttachment | AttachmentValidationFailure;

const EXTENSIONS: Record<AttachmentKind, ReadonlySet<string>> = {
  text: new Set(["txt", "text", "md", "markdown", "log", "rst"]),
  code: new Set(["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "c", "h", "cc", "cpp", "go", "rs", "html", "css", "xml", "yaml", "yml", "toml", "sql"]),
  csv: new Set(["csv"]),
  json: new Set(["json"]),
  pdf: new Set(["pdf"]),
  docx: new Set(["docx"]),
  xlsx: new Set(["xlsx"]),
  pptx: new Set(["pptx"]),
};

const FORBIDDEN_EXTENSIONS = new Set([
  "app", "apk", "bat", "bin", "cab", "class", "cmd", "com", "deb", "dll", "dmg", "exe", "iso", "jar", "msi", "o", "obj", "ps1", "rpm", "scr", "sh", "so", "sys",
  "7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip", "zst", "doc", "xls", "ppt",
  "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "ico", "heic", "avif", "svg",
]);

const utf8 = new TextDecoder("utf-8", { fatal: true });
const ATTACHMENT_KINDS = new Set<AttachmentKind>(["text", "code", "csv", "json", "pdf", "docx", "xlsx", "pptx"]);
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP_DESCRIPTOR = 0x08074b50;
const MAX_OFFICE_PART_BYTES = 5 * 1024 * 1024;
const MAX_OFFICE_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_OFFICE_XML_BYTES = 2 * 1024 * 1024;
const MAX_XML_TAG_BYTES = 8 * 1024;
const MAX_XML_TAGS = 20_000;
const MAX_XML_DEPTH = 128;
const DANGEROUS_OFFICE_PATH_MARKERS = ["embedding", "oleobject", "activex", "externallinks", "macrosheet", "dialogsheets", "customui", "vbadata"];
const DANGEROUS_OFFICE_EXTENSIONS = new Set([".bin", ".docm", ".xlsm", ".pptm", ".xlam", ".xlsb", ".exe", ".dll", ".com", ".ocx", ".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz"]);

function failure(code: AttachmentValidationCode, message: string): AttachmentValidationFailure {
  return { ok: false, code, message };
}

function validateOriginalName(name: string, kind: AttachmentKind): AttachmentValidationFailure | undefined {
  if (typeof name !== "string" || name.length === 0 || Buffer.byteLength(name, "utf8") > 255) {
    return failure("INVALID_NAME", "Original filename is empty or too long.");
  }
  if (/[/\\:\u2215\u2044\uff0f\uff3c\u0000-\u001f\u007f]/u.test(name) || /[\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    return failure("INVALID_NAME", "Original filename must be a safe basename.");
  }
  if (name === "." || name === ".." || name.startsWith(".") || /[. ]$/u.test(name) || /%(?:2e|2f|5c|00)/iu.test(name)) {
    return failure("INVALID_NAME", "Original filename is unsafe.");
  }
  const stem = name.split(".", 1)[0]!.replace(/[ .]+$/u, "").toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) {
    return failure("INVALID_NAME", "Original filename is a reserved device name.");
  }
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    return failure("UNSUPPORTED_FORMAT", "Executable, image, archive, and legacy Office formats are not accepted.");
  }
  if (extension && !EXTENSIONS[kind].has(extension)) {
    return failure("TYPE_MISMATCH", "Filename extension does not match the selected attachment type.");
  }
  return undefined;
}

function startsWithBytes(bytes: Buffer, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function isImage(bytes: Buffer): boolean {
  return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    || startsWithBytes(bytes, [0xff, 0xd8, 0xff])
    || startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38])
    || startsWithBytes(bytes, [0x42, 0x4d])
    || startsWithBytes(bytes, [0x49, 0x49, 0x2a, 0x00])
    || startsWithBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])
    || (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    || startsWithBytes(bytes, [0x00, 0x00, 0x01, 0x00]);
}

function isArchive(bytes: Buffer): boolean {
  if (bytes.length >= 4) {
    const signature = bytes.readUInt32LE(0);
    if (signature === ZIP_LOCAL || signature === ZIP_EOCD || signature === 0x08074b50
      || signature === 0x04034b50 || signature === 0x21726152 || signature === 0xfd2fb528
      || signature === 0x184d2204 || signature === 0x184c2102 || signature === 0x435a4c49) return true;
  }
  return startsWithBytes(bytes, [0x1f, 0x8b])
    || startsWithBytes(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    || startsWithBytes(bytes, [0x42, 0x5a, 0x68])
    || (bytes.length >= 262 && bytes.toString("ascii", 257, 262) === "ustar");
}

function isExecutable(bytes: Buffer): boolean {
  if (startsWithBytes(bytes, [0x4d, 0x5a]) || startsWithBytes(bytes, [0x7f, 0x45, 0x4c, 0x46])
    || startsWithBytes(bytes, [0xca, 0xfe, 0xba, 0xbe]) || startsWithBytes(bytes, [0xbe, 0xba, 0xfe, 0xca])
    || startsWithBytes(bytes, [0xfe, 0xed, 0xfa, 0xce]) || startsWithBytes(bytes, [0xce, 0xfa, 0xed, 0xfe])
    || startsWithBytes(bytes, [0xfe, 0xed, 0xfa, 0xcf]) || startsWithBytes(bytes, [0xcf, 0xfa, 0xed, 0xfe])
    || startsWithBytes(bytes, [0x00, 0x61, 0x73, 0x6d])) return true;
  // Compound archive extensions are blocked even when their final suffix is otherwise unknown.
  return false;
}

function decodeText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return utf8.decode(bytes); } catch { return undefined; }
}

function isPdf(bytes: Buffer): boolean {
  if (!/^%PDF-[0-9]\.[0-9]/u.test(bytes.toString("ascii", 0, Math.min(bytes.length, 16)))) return false;
  const endMarker = Buffer.from("%%EOF", "ascii");
  const at = bytes.lastIndexOf(endMarker);
  if (at < 0) return false;
  for (let i = at + endMarker.length; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b !== 0x00 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x20) return false;
  }
  return true;
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly dataOffset: number;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isDangerousOfficeEntry(name: string): boolean {
  const lower = name.toLowerCase();
  if (DANGEROUS_OFFICE_PATH_MARKERS.some((marker) => lower.includes(marker)) || lower.includes("vbaproject") || lower.includes("macroenabled")) return true;
  const dot = lower.lastIndexOf(".");
  const extension = dot < 0 ? "" : lower.slice(dot);
  return DANGEROUS_OFFICE_EXTENSIONS.has(extension);
}

function parseZip(bytes: Buffer): Map<string, ZipEntry> | undefined {
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minEocd; offset--) {
    if (bytes.readUInt32LE(offset) === ZIP_EOCD && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0 || entryCount > 10_000
    || centralOffset + centralSize !== eocd || centralOffset > bytes.length) return undefined;

  const entries = new Map<string, ZipEntry>();
  const localRanges: Array<[number, number]> = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== ZIP_CENTRAL) return undefined;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const unixMode = externalAttributes >>> 16;
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > eocd || nameLength === 0 || startDisk !== 0 || (method === 0 && compressedSize !== uncompressedSize) || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff || localOffset === 0xffffffff || (flags & 0x2041) !== 0
      || (flags & ~0x080e) !== 0 || (method !== 0 && method !== 8)) return undefined;
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let name: string;
    try { name = utf8.decode(nameBytes); } catch { return undefined; }
    if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === ".")
      || (unixMode & 0o170000) === 0o120000 || isDangerousOfficeEntry(name)) return undefined;
    if (entries.has(name)) return undefined;
    cursor = recordEnd;

    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== ZIP_LOCAL) return undefined;
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressed = bytes.readUInt32LE(localOffset + 18);
    const localUncompressed = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength || dataEnd > centralOffset
      || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)
      || ((flags & 8) === 0 && (localCrc !== checksum || localCompressed !== compressedSize || localUncompressed !== uncompressedSize))
      || ((flags & 8) !== 0 && ((localCrc !== 0 && localCrc !== checksum) || (localCompressed !== 0 && localCompressed !== compressedSize) || (localUncompressed !== 0 && localUncompressed !== uncompressedSize)))) return undefined;
    let localEnd = dataEnd;
    if ((flags & 8) !== 0) {
      const hasSignature = dataEnd + 4 <= centralOffset && bytes.readUInt32LE(dataEnd) === ZIP_DESCRIPTOR;
      const descriptorAt = hasSignature ? dataEnd + 4 : dataEnd;
      if (descriptorAt + 12 > centralOffset || bytes.readUInt32LE(descriptorAt) !== checksum
        || bytes.readUInt32LE(descriptorAt + 4) !== compressedSize || bytes.readUInt32LE(descriptorAt + 8) !== uncompressedSize) return undefined;
      localEnd = descriptorAt + 12;
    }
    localRanges.push([localOffset, localEnd]);
    entries.set(name, { name, method, flags, crc: checksum, compressedSize, uncompressedSize, dataOffset });
  }
  if (cursor !== eocd) return undefined;
  localRanges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < localRanges.length; i++) if (localRanges[i - 1]![1] > localRanges[i]![0]) return undefined;
  return entries;
}

function extractZipEntry(bytes: Buffer, entry: ZipEntry): Buffer | undefined {
  if (entry.uncompressedSize > MAX_OFFICE_PART_BYTES) return undefined;
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  try {
    const outputLimit = Math.min(MAX_OFFICE_PART_BYTES, entry.uncompressedSize + 1);
    const output = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: outputLimit });
    if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc) return undefined;
    return output;
  } catch { return undefined; }
}

interface XmlTag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: ReadonlyMap<string, string>;
}

function isXmlSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function isXmlNameStart(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || char === "_" || char === ":";
}

function isXmlNamePart(char: string | undefined): boolean {
  if (isXmlNameStart(char)) return true;
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || char === "-" || char === ".";
}

function parseXmlTag(raw: string): XmlTag | undefined {
  let cursor = 1;
  const closing = raw[cursor] === "/";
  if (closing) cursor++;
  const nameStart = cursor;
  if (!isXmlNameStart(raw[cursor])) return undefined;
  cursor++;
  while (isXmlNamePart(raw[cursor])) cursor++;
  const name = raw.slice(nameStart, cursor);
  const attrs = new Map<string, string>();
  let selfClosing = false;
  while (cursor < raw.length) {
    while (isXmlSpace(raw[cursor]!)) cursor++;
    if (raw[cursor] === ">") {
      return cursor === raw.length - 1 ? { name, closing, selfClosing, attributes: attrs } : undefined;
    }
    if (raw[cursor] === "/" && raw[cursor + 1] === ">") {
      if (closing || cursor + 2 !== raw.length) return undefined;
      selfClosing = true;
      return { name, closing, selfClosing, attributes: attrs };
    }
    if (closing || !isXmlNameStart(raw[cursor])) return undefined;
    const attrStart = cursor++;
    while (isXmlNamePart(raw[cursor])) cursor++;
    const attrName = raw.slice(attrStart, cursor);
    if (attrs.has(attrName)) return undefined;
    while (isXmlSpace(raw[cursor]!)) cursor++;
    if (raw[cursor++] !== "=") return undefined;
    while (isXmlSpace(raw[cursor]!)) cursor++;
    const quote = raw[cursor++];
    if (quote !== "'" && quote !== '"') return undefined;
    const valueStart = cursor;
    while (cursor < raw.length - 1 && raw[cursor] !== quote) {
      if (raw[cursor] === "<") return undefined;
      cursor++;
    }
    if (raw[cursor] !== quote) return undefined;
    attrs.set(attrName, raw.slice(valueStart, cursor));
    cursor++;
  }
  return undefined;
}

function onlyXmlSpace(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (!isXmlSpace(text[i]!)) return false;
  return true;
}

function scanXml(bytes: Buffer | undefined): XmlTag[] | undefined {
  if (!bytes || bytes.length > MAX_OFFICE_XML_BYTES) return undefined;
  const text = decodeText(bytes);
  if (!text) return undefined;
  const tags: XmlTag[] = [];
  const stack: string[] = [];
  let cursor = 0;
  let rootCount = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "<") {
      const next = text.indexOf("<", cursor);
      const end = next < 0 ? text.length : next;
      if (stack.length === 0 && !onlyXmlSpace(text, cursor, end)) return undefined;
      cursor = end;
      continue;
    }
    if (text.startsWith("<!--", cursor)) {
      const end = text.indexOf("-->", cursor + 4);
      if (end < 0) return undefined;
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", cursor)) {
      if (stack.length === 0) return undefined;
      const end = text.indexOf("]]>", cursor + 9);
      if (end < 0) return undefined;
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<?", cursor)) {
      const end = text.indexOf("?>", cursor + 2);
      if (end < 0) return undefined;
      cursor = end + 2;
      continue;
    }
    if (text.startsWith("<!", cursor)) return undefined;

    let end = cursor + 1;
    let quote = "";
    for (; end < text.length; end++) {
      if (end - cursor + 1 > MAX_XML_TAG_BYTES) return undefined;
      const char = text[end]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === "'" || char === '"') {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end >= text.length || quote) return undefined;
    const tag = parseXmlTag(text.slice(cursor, end + 1));
    if (!tag || tags.length >= MAX_XML_TAGS) return undefined;
    tags.push(tag);
    if (tag.closing) {
      if (stack.pop() !== tag.name) return undefined;
    } else if (stack.length === 0) {
      if (rootCount !== 0) return undefined;
      rootCount++;
      if (!tag.selfClosing) stack.push(tag.name);
    } else if (!tag.selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) return undefined;
      stack.push(tag.name);
    }
    cursor = end + 1;
  }
  return rootCount === 1 && stack.length === 0 ? tags : undefined;
}

function localTagName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

interface OfficeMain {
  readonly path: string;
  readonly partContentType: string;
  readonly root: string;
  readonly namespace: string;
  readonly requiredChild: string;
}

const OFFICE_MAIN: Record<"docx" | "xlsx" | "pptx", OfficeMain> = {
  docx: {
    path: "word/document.xml",
    partContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    root: "document",
    namespace: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    requiredChild: "body",
  },
  xlsx: {
    path: "xl/workbook.xml",
    partContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    root: "workbook",
    namespace: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    requiredChild: "sheets",
  },
  pptx: {
    path: "ppt/presentation.xml",
    partContentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    root: "presentation",
    namespace: "http://schemas.openxmlformats.org/presentationml/2006/main",
    requiredChild: "sldIdLst",
  },
};

function rootElement(tags: readonly XmlTag[], name: string, namespace: string): XmlTag | undefined {
  const root = tags.find((tag) => !tag.closing);
  if (!root || localTagName(root.name) !== name) return undefined;
  const prefix = root.name.includes(":") ? root.name.slice(0, root.name.indexOf(":")) : undefined;
  return root.attributes.get(prefix ? `xmlns:${prefix}` : "xmlns") === namespace ? root : undefined;
}

function validOfficeXml(kind: "docx" | "xlsx" | "pptx", parts: ReadonlyMap<string, Buffer>): boolean {
  const spec = OFFICE_MAIN[kind];
  const contentTypes = scanXml(parts.get("[Content_Types].xml"));
  const relationships = scanXml(parts.get("_rels/.rels"));
  const main = scanXml(parts.get(spec.path));
  if (!contentTypes || !relationships || !main
    || !rootElement(contentTypes, "Types", "http://schemas.openxmlformats.org/package/2006/content-types")
    || !rootElement(relationships, "Relationships", "http://schemas.openxmlformats.org/package/2006/relationships")) return false;
  if (contentTypes.some((tag) => [...tag.attributes.values()].some((value) => /macroenabled|vbaproject|macrosheet/iu.test(value)))) return false;
  const overrides = contentTypes.filter((tag) => !tag.closing && localTagName(tag.name) === "Override");
  if (!overrides.some((tag) => tag.attributes.get("PartName") === `/${spec.path}` && tag.attributes.get("ContentType") === spec.partContentType)) return false;

  const relations = relationships.filter((tag) => !tag.closing && localTagName(tag.name) === "Relationship");
  if (relations.some((tag) => tag.attributes.get("TargetMode")?.toLowerCase() === "external")) return false;
  const officeRel = relations.find((tag) => tag.attributes.get("Type") === "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument");
  if (!officeRel) return false;
  const target = officeRel.attributes.get("Target");
  if (!target || target.includes("\\") || target.includes("%") || target.startsWith("//")) return false;
  const normalizedTarget = target.startsWith("/") ? target.slice(1) : target;
  if (normalizedTarget !== spec.path) return false;

  const mainRoot = rootElement(main, spec.root, spec.namespace);
  return mainRoot !== undefined && main.some((tag) => !tag.closing && localTagName(tag.name) === spec.requiredChild);
}

function validateOffice(kind: "docx" | "xlsx" | "pptx", bytes: Buffer): boolean {
  const entries = parseZip(bytes);
  if (!entries || !entries.has("[Content_Types].xml") || !entries.has("_rels/.rels") || !entries.has(OFFICE_MAIN[kind].path)) return false;
  const requiredParts = new Set(["[Content_Types].xml", "_rels/.rels", OFFICE_MAIN[kind].path]);
  const parts = new Map<string, Buffer>();
  let totalUncompressed = 0;
  for (const entry of entries.values()) {
    if (entry.uncompressedSize > MAX_OFFICE_PART_BYTES || totalUncompressed + entry.uncompressedSize > MAX_OFFICE_TOTAL_BYTES) return false;
    totalUncompressed += entry.uncompressedSize;
  }
  for (const [name, entry] of entries) {
    const content = extractZipEntry(bytes, entry);
    if (!content || isArchive(content) || isExecutable(content)) return false;
    if (requiredParts.has(name)) parts.set(name, content);
    if (name.toLowerCase().endsWith(".rels")) {
      const tags = scanXml(content);
      if (!tags || tags.some((tag) => !tag.closing && localTagName(tag.name) === "Relationship"
        && tag.attributes.get("TargetMode")?.toLowerCase() === "external")) return false;
    }
  }
  return validOfficeXml(kind, parts);
}

export function validateAttachment(input: AttachmentInput): AttachmentValidationResult {
  if (!input || !Buffer.isBuffer(input.bytes) && !(input.bytes instanceof Uint8Array)) {
    return failure("INVALID_CONTENT", "Attachment bytes must be a byte buffer.");
  }
  const bytes = Buffer.from(input.bytes);
  if (bytes.length > ATTACHMENT_MAX_BYTES) return failure("TOO_LARGE", "Attachment exceeds the 20 MiB limit.");
  if (!ATTACHMENT_KINDS.has(input.kind)) return failure("TYPE_MISMATCH", "Selected attachment type is not supported.");
  const nameFailure = validateOriginalName(input.originalName, input.kind);
  if (nameFailure) return nameFailure;
  if (isImage(bytes)) return failure("UNSUPPORTED_FORMAT", "Image attachments are not accepted by this policy.");
  if (isExecutable(bytes)) return failure("UNSUPPORTED_FORMAT", "Executable attachments are not accepted.");

  let contentIsValid = false;
  if (input.kind === "pdf") {
    contentIsValid = isPdf(bytes);
  } else if (input.kind === "docx" || input.kind === "xlsx" || input.kind === "pptx") {
    contentIsValid = validateOffice(input.kind, bytes);
  } else {
    if (isArchive(bytes) || startsWithBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
      || startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46])) {
      return failure("UNSUPPORTED_FORMAT", "Compressed, binary, or non-text attachments are not accepted for this type.");
    }
    const text = decodeText(bytes);
    if (input.kind === "json") {
      if (text !== undefined) {
        try { JSON.parse(text); contentIsValid = true; } catch { contentIsValid = false; }
      }
    } else {
      contentIsValid = text !== undefined;
    }
  }
  if (!contentIsValid) return failure("TYPE_MISMATCH", "Attachment bytes do not match the selected supported type.");
  return {
    ok: true,
    kind: input.kind,
    originalName: input.originalName,
    bytes,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
