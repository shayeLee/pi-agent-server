import { describe, it, expect } from "vitest";
import { SseParser } from "./sse.js";

describe("SseParser（SSE 帧解析）", () => {
  it("解析单帧 id + data", () => {
    const p = new SseParser();
    expect(p.push('id: 1\ndata: {"type":"text_delta","text":"hi"}\n\n')).toEqual([
      { id: "1", data: '{"type":"text_delta","text":"hi"}' },
    ]);
  });

  it("一次解析多帧", () => {
    const p = new SseParser();
    const text = 'id: 1\ndata: {"type":"status","phase":"agent_start"}\n\nid: 2\ndata: {"type":"completed"}\n\n';
    expect(p.push(text)).toHaveLength(2);
  });

  it("分块到达时只返回完整帧，半帧留在缓冲", () => {
    const p = new SseParser();
    expect(p.push('id: 1\ndata: {"type":"com')).toEqual([]); // 半帧
    expect(p.push('pleted"}\n\n')).toEqual([{ id: "1", data: '{"type":"completed"}' }]);
  });

  it("忽略心跳注释行（: 开头）", () => {
    const p = new SseParser();
    expect(p.push(': ping\n\n')).toEqual([]);
  });

  it("忽略无 data 的帧（如只有 id）", () => {
    const p = new SseParser();
    expect(p.push("id: 5\n\n")).toEqual([]);
  });

  it("多行 data 以换行拼接", () => {
    const p = new SseParser();
    expect(p.push("data: line1\ndata: line2\n\n")).toEqual([
      { id: null, data: "line1\nline2" },
    ]);
  });
});
