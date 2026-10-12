export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
export function resultText(value: unknown): string {
  const content = record(value).content;
  return Array.isArray(content) ? content.filter(block => record(block).type === "text").map(block => text(record(block).text)).join("\n") : text(value);
}
export const line = (value: unknown): string => {
  const compact = text(value).replace(/\s+/g, " ").trim();
  return compact;
};
export const lines = (value: string): string[] => value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
