import { useMemo, useRef } from "react";
import { ApiError } from "pi-agent-server/client";
import type { ApiClient, SessionRecord } from "pi-agent-server/client";
import { validateSelection, type UnsentAttachment, type UnsentMessage } from "../../attachment-state.js";
import { createDraftStore } from "../../draft-store.js";
import type { Selection } from "./useSelection.js";

/** Per-scope unsent drafts (text, new-session settings, attachments) and attachment upload/read. */
export function useDrafts({ api, selection, sessions }: {
  api: ApiClient;
  selection: Selection;
  sessions: SessionRecord[] | null;
}) {
  const { activeSessionId, activeProjectId, currentScope, invalidateRestore } = selection;
  const draftStore = useMemo(() => createDraftStore(), []);
  const draftTextRevisionsRef = useRef(new Map<string, number>());

  function updateUnsent(scope: string, change: (previous: UnsentMessage) => UnsentMessage): void {
    draftStore.update(scope, change);
  }
  function setUnsentText(text: string): void {
    invalidateRestore();
    draftTextRevisionsRef.current.set(currentScope, (draftTextRevisionsRef.current.get(currentScope) ?? 0) + 1);
    updateUnsent(currentScope, (previous) => ({ ...previous, text }));
  }
  function setNewSessionSettings(config: UnsentMessage["settings"]): void {
    invalidateRestore();
    updateUnsent(currentScope, (previous) => ({ ...previous, settings: { ...previous.settings, ...config } }));
  }
  function removeUnsentAttachment(localId: string): void {
    updateUnsent(currentScope, (previous) => ({ ...previous,
      attachments: previous.attachments.filter((item) => item.localId !== localId) }));
  }
  function updateAttachment(scope: string, localId: string, change: (item: UnsentAttachment) => UnsentAttachment): void {
    // An in-flight upload/read may finish after its draft moved to a session.
    const owner = draftStore.getSnapshot(scope).attachments.some(item => item.localId === localId)
      ? scope : Object.keys(draftStore.getAll()).find(key =>
        draftStore.getSnapshot(key).attachments.some(item => item.localId === localId));
    if (!owner) return; // Removed attachments must not be resurrected.
    updateUnsent(owner, (previous) => ({ ...previous, attachments: previous.attachments.map((item) =>
      item.localId === localId ? change(item) : item) }));
  }
  function fileBytes(file: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(new Uint8Array(reader.result)) : reject(new Error("文件读取失败"));
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsArrayBuffer(file);
    });
  }
  async function uploadSelectedFile(scope: string, projectId: string, localId: string, file: File, kind: Exclude<UnsentAttachment["kind"], "image">, uploadKey: string): Promise<void> {
    try {
      const bytes = await fileBytes(file);
      const server = await api.uploadFile({ projectId, uploadKey, name: file.name, mediaType: file.type,
        kind, bytes });
      updateAttachment(scope, localId, (item) => ({ ...item, status: "ready", file: undefined, error: undefined, server }));
    } catch (error) {
      const interrupted = !(error instanceof ApiError);
      updateAttachment(scope, localId, (item) => ({ ...item, status: interrupted ? "interrupted" : "error",
        file: interrupted ? undefined : file,
        error: interrupted ? "上传中断；请重新选择文件" : error instanceof Error ? error.message : "上传失败" }));
    }
  }
  async function addUnsentFile(file: File): Promise<void> {
    invalidateRestore();
    const scope = currentScope;
    const existing = draftStore.getSnapshot(scope).attachments;
    const check = validateSelection(existing, file);
    if ("error" in check) {
      const id = crypto.randomUUID();
      updateUnsent(scope, (previous) => ({ ...previous, attachments: [...previous.attachments,
        { localId: id, name: file.name, size: file.size, mediaType: file.type,
          kind: "text", status: "error", error: check.error }] }));
      return;
    }
    const localId = crypto.randomUUID();
    const session = activeSessionId ? sessions?.find((record) => record.id === activeSessionId) : null;
    const projectId = session?.projectId ?? activeProjectId;
    const item: UnsentAttachment = { localId, name: file.name, size: file.size, mediaType: file.type,
      kind: check.kind, status: check.kind === "image" ? "processing" : "uploading",
      ...(check.kind === "image" ? {} : { file, uploadKey: crypto.randomUUID() }) };
    updateUnsent(scope, (previous) => ({ ...previous, attachments: [...previous.attachments, item] }));
    if (check.kind === "image") {
      try {
        const bytes = await fileBytes(file);
        const base64 = btoa(Array.from({ length: Math.ceil(bytes.length / 8192) }, (_, chunk) =>
          String.fromCharCode(...bytes.subarray(chunk * 8192, (chunk + 1) * 8192))).join(""));
        updateAttachment(scope, localId, (current) => ({ ...current, status: "ready",
          image: { mediaType: file.type, base64, preview: `data:${file.type};base64,${base64}` } }));
      } catch {
        updateAttachment(scope, localId, (current) => ({ ...current, status: "error", error: "图片读取失败" }));
      }
    } else if (projectId) {
      await uploadSelectedFile(scope, projectId, localId, file, check.kind, item.uploadKey!);
    } else {
      updateAttachment(scope, localId, (current) => ({ ...current, status: "error", error: "请先选择项目" }));
    }
  }
  async function retryUnsentAttachment(localId: string): Promise<void> {
    const scope = currentScope;
    const item = draftStore.getSnapshot(scope).attachments.find((entry) => entry.localId === localId);
    if (!item?.file || !item.uploadKey || item.kind === "image") return;
    const session = activeSessionId ? sessions?.find((record) => record.id === activeSessionId) : null;
    const projectId = session?.projectId ?? activeProjectId;
    if (!projectId) return;
    updateAttachment(scope, localId, (current) => ({ ...current, status: "uploading", error: undefined }));
    await uploadSelectedFile(scope, projectId, localId, item.file, item.kind, item.uploadKey);
  }

  return {
    draftStore,
    draftTextRevisionsRef,
    updateUnsent,
    setUnsentText,
    setNewSessionSettings,
    removeUnsentAttachment,
    addUnsentFile,
    retryUnsentAttachment,
  };
}

export type Drafts = ReturnType<typeof useDrafts>;
