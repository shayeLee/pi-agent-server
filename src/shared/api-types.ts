// Public DTO definitions: no server, storage, SDK, or Node dependencies.
export type AccessCapabilities = { readonly canRead: boolean; readonly canWrite: boolean };
export type ModelDescriptor = { provider: string; id: string; name: string };
export type ProjectDto = { id: string; name: string; cwd: string; isDefault: boolean; canDelete?: boolean; canCreateSession?: boolean };
export type SessionDto = {
  id: string;
  ownerKey: string;
  visibility?: "private" | "shared";
  origin?: "managed" | "native";
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  systemPrompt: string | null;
  capabilityVersions: string | null;
  /** Display-only persisted first user prompt, never written to title. */
  firstPrompt?: string | null;
};
export type ImageInput = { mediaType: string; base64: string };

/** Shared shape; server-only hooks are retained for compatibility with the original contract. */
export type MessageInput = {
  requestId: string;
  /** Server-only actor binding for native shared request IDs. */
  idempotencyActor?: string;
  prompt: string;
  parentId?: string;
  images?: ImageInput[];
  /** Validated, ordered references; never sent to Pi. */
  fileIds?: string[];
  /** Server-only admission hook, never part of the fingerprint. */
  beforeAccept?: () => Promise<void>;
};

/** Stable, runtime-frozen turn budget error vocabulary. */
export const TURN_ERROR_CODES = Object.freeze({
  toolBudget: "turn_tool_budget_exceeded",
  durationBudget: "turn_duration_budget_exceeded",
  assistantTextBudget: "turn_assistant_text_budget_exceeded",
} as const);
