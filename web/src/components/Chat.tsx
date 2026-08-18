import { useEffect, useRef } from "react";
import type { ChatState } from "../lib/chat-state.js";
import type { ModelInfo, SessionRecord, UsageStats } from "../types.js";
import { MessageItem } from "./MessageItem.js";
import { ToolCallCard } from "./ToolCallCard.js";
import { Composer } from "./Composer.js";
import { StatsBar } from "./StatsBar.js";
import { ChatHeader } from "./ChatHeader.js";
import { EmptyState } from "./EmptyState.js";

export type ChatProps = {
  session: SessionRecord | null;
  timeline: ChatState["timeline"];
  streaming: boolean;
  queued: boolean;
  loadError: string | null;
  models: ModelInfo[];
  thinkingLevels: string[];
  defaultModel: ModelInfo | null;
  defaultThinkingLevel: string;
  connected: boolean;
  stats: UsageStats | null;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onFollowUp: (text: string) => void;
  onAbort: () => void;
  onToggleDetails: () => void;
  onConfigChange: (config: { modelProvider?: string; modelId?: string; thinkingLevel?: string }) => void;
};

export function Chat({
  session,
  timeline,
  streaming,
  queued,
  loadError,
  models,
  thinkingLevels,
  defaultModel,
  defaultThinkingLevel,
  connected,
  stats,
  onSend,
  onSteer,
  onFollowUp,
  onAbort,
  onToggleDetails,
  onConfigChange,
}: ChatProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // 新事件到达时自动滚动到底部
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [timeline]);

  const hasMessages = timeline.length > 0;
  const placeholder = hasMessages ? "Message the agent" : "Describe what you want to build";

  return (
    <section className="chat" data-testid="chat">
      {session && (
        <ChatHeader
          session={session}
          connected={connected}
          onToggleDetails={onToggleDetails}
        />
      )}
      <div className="chat-body" ref={bodyRef} data-testid="chat-body">
        {!session ? (
          <div className="empty-hint" data-testid="no-session-hint">
            选择或新建一个会话开始聊天
          </div>
        ) : (
          <div className="chat-inner">
            {loadError && (
              <div className="chat-phase-banner error" data-testid="load-error">
                {loadError}
              </div>
            )}
            {queued && (
              <div className="chat-phase-banner queued" data-testid="phase-queued">
                排队中…
              </div>
            )}
            {!hasMessages ? (
              <EmptyState />
            ) : (
              <div className="timeline" data-testid="message-list">
                {timeline.map((item) =>
                  item.kind === "tool" ? (
                    <ToolCallCard key={item.id} call={item.call} />
                  ) : (
                    <MessageItem key={item.id} item={item} />
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {session && (
        <div className="chat-footer">
          <Composer
            session={session}
            models={models}
            thinkingLevels={thinkingLevels}
            defaultModel={defaultModel}
            defaultThinkingLevel={defaultThinkingLevel}
            streaming={streaming}
            queued={queued}
            placeholder={placeholder}
            onSend={onSend}
            onSteer={onSteer}
            onFollowUp={onFollowUp}
            onAbort={onAbort}
            onConfigChange={onConfigChange}
          />
          <StatsBar stats={stats} connected={connected} timeline={timeline} />
        </div>
      )}
    </section>
  );
}
