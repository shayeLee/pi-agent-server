/** 把 unknown 值转成可读文本：字符串原样展示，其它 JSON 美化序列化。 */
export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
