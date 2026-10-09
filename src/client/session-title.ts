/** Display-only metadata; never use the resolved title as a rename payload. */
export type SessionTitleSource = { title: string; firstPrompt?: string | null };

export function resolveSessionDisplayTitle(session: SessionTitleSource): string {
  if (session.title.trim()) return session.title;
  return session.firstPrompt?.trim() || "未命名会话";
}

/** The first user message counts even when it has no text (e.g. image-only). */
export function firstUserPrompt(messages: readonly unknown[]): string | null {
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as { role?: unknown; text?: unknown; content?: unknown };
    if (message.role !== "user") continue;
    if (typeof message.text === "string") return message.text;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) return message.content
      .filter((block): block is { type: "text"; text: string } => !!block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text).join("\n");
    return "";
  }
  return null;
}
