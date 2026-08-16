// SSE 帧解析（纯逻辑，无 DOM 依赖）：把累积的 SSE 文本切分为完整帧，
// 并解析出 id 与 data。心跳注释（":" 开头）与无 data 的帧被忽略。

export type SseFrame = {
  /** SSE 事件 id（Last-Event-ID 续传基准）；可能为 null。 */
  id: string | null;
  /** data 字段内容（多行 data 以换行拼接）。 */
  data: string;
};

export class SseParser {
  private buffer = "";

  /** 追加文本块，返回其中已完整的事件帧。 */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const parsed = parseFrame(frame);
      if (parsed) frames.push(parsed);
    }
    return frames;
  }
}

function parseFrame(frame: string): SseFrame | null {
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // 注释/心跳
    if (line.startsWith("id:")) {
      id = line.slice(3).trim() || null;
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return { id, data: dataLines.join("\n") };
}
