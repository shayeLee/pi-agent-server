export type SessionStepKind = 'user' | 'thinking' | 'assistant_text' | 'tool_call' | 'tool_result' | 'notification' | 'system_event' | 'error' | 'compaction' | 'custom';
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
