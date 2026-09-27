// SSE frame parser (pure logic, no browser DOM dependency): split accumulated text into complete frames.

export type SseFrame = {
  /** SSE event id (Last-Event-ID resume cursor); may be null. */
  id: string | null;
  /** data field content (multiple data lines are joined with a newline). */
  data: string;
};

export class SseParser {
  private buffer = "";

  /** Append a text chunk and return complete event frames found in it. */
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
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) {
      id = line.slice(3).trim() || null;
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return { id, data: dataLines.join("\n") };
}
