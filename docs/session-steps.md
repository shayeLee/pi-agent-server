# Session steps and Inspector

This document defines the session-step projection and Inspector read contract. The documented UI tab order is **Steps** (default), **System prompt**, **Events**. The existing Events view/stream retains its behavior. The Inspector consumes independent read-only snapshots; it does not reconstruct steps from chat cards or replay the event log. Chat-position navigation and highlighting remain outside this implementation.

## Steps snapshot

`GET /v1/sessions/:id/steps` returns a complete snapshot, not a delta. It is read-only, does not create a runtime, and uses the same authorization tier and source/ownership guards as session export. Missing or inaccessible sessions use the normal indistinguishable not-found response.

```ts
export type SessionStepKind =
  | 'user' | 'thinking' | 'assistant_text' | 'tool_call' | 'tool_result'
  | 'notification' | 'system_event' | 'error' | 'compaction' | 'custom';

export type SessionStep = {
  id: string;
  kind: SessionStepKind;
  content: unknown;
  status: 'streaming' | 'completed' | 'error' | 'aborted' | 'unknown';
  source: 'recorded' | 'observed';
  timestamp?: string;
  sourceEntryId?: string;
  requestId?: string;
  toolName?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  label?: string;
  images?: Array<{ mediaType: string; base64: string }>;
  omission?: string;
};

export type SessionStepsSnapshot = {
  sessionId: string;
  projectionId: string;
  revision: number;
  steps: SessionStep[];
};
```

`steps` array order is authoritative. The Inspector must not sort by kind or timestamp. Include assistant thinking as its own step, assistant text, tool calls, and tool results as separate steps, alongside user and other safely projectable semantic entries. Do not infer steps from chat's merged tool cards. Preserve meaningful empty values (`''`, `0`, `false`, `null`); use `omission` only to explain an actual source omission or security projection, never to guess missing data. Content is full and subject to existing redaction and safe image projection, not summary-truncated. Do not expose private extension state, encrypted thinking signatures, arbitrary file reads, or remote media.

The server builds the projection from the selected saved branch, preserving entry and content-block order, and observes the live SDK lifecycle to include active, not-yet-persisted content. Tool calls and results have independent identities; append a result at its observed completion position. Do not reorder results later based on message persistence or merge identical text across assistant messages. Reconcile persisted entry IDs after SDK message completion without text-based matching. A branch change starts a new projection identity. Snapshots are defensive copies; revision increases when step content, status, or source changes. A new projection replaces the prior snapshot; within one projection, clients reject older revisions.

Saved history can only reproduce its persisted branch/block order. After a restart, the service cannot reconstruct parallel tool completion timing that was never persisted. Therefore this projection is **not** a permanently complete SDK event archive, and historical order must not be described as recovered real-time completion order.

The Steps tab fetches only while visible, coalescing refreshes to at most one request per 500 ms; hide stops polling. Reopening, switching sessions, or reconnecting obtains a complete snapshot. Failed refresh keeps the previous snapshot and reports the failure. Request generations prevent stale responses from crossing sessions. Selection and expansion state should be keyed by stable step ID. This polling does not add an SSE event type and does not rely on a bounded SSE buffer or chat timeline deduplication.

## System prompt

`GET /v1/sessions/:id/system-prompt` (Fastify also provides `HEAD`) returns exactly a provenance source and prompt:

```ts
export type SessionSystemPrompt =
  | { source: 'live_effective' | 'creation_snapshot'; prompt: string }
  | { source: 'unavailable'; prompt: null };
```

It is a read-only operation using the session-export authorization tier and existing managed ownership/native source guards. It takes no client path or cwd, does not create a runtime, probe model availability, invoke a model, write history, or change transcript projection. Missing, unauthorized-owner, revoked-source, or disposed guarded runtime cases remain indistinguishable 404s; role denial uses the existing 403 response.

- `live_effective` is read from an already-existing SDK instance's public read-only `session.systemPrompt` getter. It is the current effective prompt and does **not** prove that this text was sent to a model.
- `creation_snapshot` is the original recorded creation prompt when no live getter is available. It is not a reconstruction of historical dynamic prompt state and must not be presented as runtime-effective.
- `unavailable` means neither a readable live string nor a recorded creation string exists. This is a successful response with `prompt: null`, not a missing session.

A valid empty string is retained. A live getter failure does not fall back to the creation snapshot. Do not infer `last_sent` from structured transcript replay: extension-forced prompts are not proven by that replay.

## Inspector and visual boundary

Inspector starts closed and opens as a 380px right grid column, shrinking rather than covering chat. There is no Inspector backdrop or focus trap. At ≤600px it takes the available width and hides the still-mounted chat, preserving drafts; Close/Escape restores chat and trace-entry focus. Steps scroll independently. The left mobile navigation retains its separate overlay drawer. Polling visibility and session isolation are unchanged.

Inspector 默认关闭，打开后作为 380px 右侧 grid 栏挤出聊天，不覆盖聊天，无专用遮罩或焦点陷阱。≤600px 时占可用宽度，聊天隐藏但保持挂载和草稿；关闭／Esc 返回聊天并回焦轨迹入口。步骤独立滚动。左侧移动导航仍是独立 overlay 抽屉，轮询可见性和会话隔离不变。

The tab sequence is **Steps → System prompt → Events**, with Steps selected by default. Events remains the existing event-log feature. The reference-session-steps design applies only to Inspector and does not alter the confirmed sidebar (280px), logo (26px), composer (124px desktop / 160px mobile), theme persistence, or focus behavior. It does not add send modes, a stop button, or a raw-data footer to tool cards.

Collapsed rows follow the reference's compact numbered timeline, while retaining the confirmed reduced typography and 380px Inspector. Model and thinking-level changes use Chinese semantic titles and exact DTO provider/modelId/thinkingLevel values, not JSON braces or guessed nested values. System history remains in the array even with the independent System prompt tab; summary text comes from content or the known `sections: Record<string, string | null>` boundary; empty or unrecognized shapes use an honest generic summary. No metadata is filtered to match the reference's example count. Count and order remain snapshot-authoritative.

Expand a row to read all public content, unknown fields and meaningful empty values; no raw-data view/copy controls are added. Provenance is in the panel title and timestamp titles distinguish recorded from first-observed time, not permanent complete execution history. An omission marker remains visible when collapsed; known reasons are explained in Chinese on expansion, unknown reasons retain their original text. Result tint and existing status SVGs follow actual status, never inferred body text. Short summaries have no fixed content height; long expanded text grows and scrolls normally. Rendering is inert text except existing validated image attachments.

Regression coverage includes full-App GET fixtures with consecutive real-shaped metadata, content blocks, nested result details, unknown fields, null/false/0/empty values, keyboard interaction and unchanged snapshot order/count. Reference-correction screenshots at 1440/1280/390 in both themes are written to `/tmp/pi-steps-reference-correction` by `inspector-app.spec.ts` under the existing steps config; these are isolated mock data, not live session or pixel-perfect reference evidence.

Scroll-to-step and temporary target highlighting are future behavior unless separately verified as implemented; documentation must not present them as delivered in this round.
