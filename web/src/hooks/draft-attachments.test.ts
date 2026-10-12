import { afterEach, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "pi-agent-server/client";
import { EMPTY_MESSAGE, FILE_LIMITS, IMAGE_LIMITS, type UnsentAttachment } from "../attachment-state.js";
import { createDraftStore } from "../draft-store.js";
import { createDraftAttachmentActions } from "./draft-attachments.js";

function fixture() {
  const draftStore = createDraftStore();
  const invalidateRestore = vi.fn();
  const actions = createDraftAttachmentActions({
    api: new ApiClient({ baseUrl: "" }), draftStore, currentScope: "new:p1",
    getProjectId: () => "p1", invalidateRestore,
  });
  return { draftStore, invalidateRestore, ...actions };
}
function pendingUpload() {
  let resolve!: (value: Awaited<ReturnType<ApiClient["uploadFile"]>>) => void;
  const promise = new Promise<Awaited<ReturnType<ApiClient["uploadFile"]>>>(yes => { resolve = yes; });
  const upload = vi.spyOn(ApiClient.prototype, "uploadFile").mockReturnValue(promise);
  return { upload, resolve };
}
const file = () => new File(["fixture"], "fixture.txt", { type: "text/plain" });
const server = { fileId: "f1", name: "fixture.txt", mediaType: "text/plain", size: 7, status: "ready" as const, agentPath: "/fixture.txt" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const image = (index: number) => new File([`image-${index}`], `image-${index}.png`, { type: "image/png" });

it("retains the first image slots in a concurrent batch; excess selections do no read or draft work", async () => {
  const upload = vi.spyOn(ApiClient.prototype, "uploadFile");
  const read = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
  const createObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL });
  const { draftStore, addUnsentFile, invalidateRestore } = fixture();
  const selected = Array.from({ length: IMAGE_LIMITS.maxCount + 2 }, (_, index) => image(index));
  const pending = selected.map(addUnsentFile);
  expect(draftStore.getSnapshot("new:p1").attachments.map(item => item.name))
    .toEqual(selected.slice(0, IMAGE_LIMITS.maxCount).map(item => item.name));
  expect(draftStore.getSnapshot("new:p1").attachments.every(item => item.status === "processing")).toBe(true);
  await Promise.all(pending);
  const ready = draftStore.getSnapshot("new:p1");
  expect(ready.attachments.every(item => item.status === "ready" && !item.error)).toBe(true);
  expect(read).toHaveBeenCalledTimes(IMAGE_LIMITS.maxCount);
  expect(invalidateRestore).toHaveBeenCalledTimes(IMAGE_LIMITS.maxCount);
  expect(upload).not.toHaveBeenCalled();
  expect(createObjectURL).not.toHaveBeenCalled();
  await addUnsentFile(image(selected.length));
  expect(draftStore.getSnapshot("new:p1")).toBe(ready);
  expect(read).toHaveBeenCalledTimes(IMAGE_LIMITS.maxCount);
});

it("ignores excess across batches and accepts a replacement after removal", async () => {
  const { draftStore, addUnsentFile, removeUnsentAttachment } = fixture();
  await addUnsentFile(image(0));
  const remaining = Array.from({ length: IMAGE_LIMITS.maxCount }, (_, index) => image(index + 1));
  await Promise.all(remaining.map(addUnsentFile));
  const full = draftStore.getSnapshot("new:p1");
  expect(full.attachments.map(item => item.name))
    .toEqual(Array.from({ length: IMAGE_LIMITS.maxCount }, (_, index) => image(index).name));
  removeUnsentAttachment(full.attachments[0]!.localId);
  const replacement = image(remaining.length + 1);
  await addUnsentFile(replacement);
  expect(draftStore.getSnapshot("new:p1").attachments.map(item => item.name))
    .toEqual([...full.attachments.slice(1).map(item => item.name), replacement.name]);
  expect(draftStore.getSnapshot("new:p1").attachments.every(item => item.status === "ready")).toBe(true);
});

it.each(["processing", "uploading", "ready", "error", "interrupted"] as const)(
  "retained %s images reserve slots without masking their existing state", async status => {
    const read = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
    const { draftStore, addUnsentFile } = fixture();
    const attachments: UnsentAttachment[] = Array.from({ length: IMAGE_LIMITS.maxCount }, (_, index) => ({
      localId: `image-${index}`, name: image(index).name, size: 1, mediaType: "image/png", kind: "image", status,
      ...(status === "error" ? { error: "图片读取失败" } : {}),
    }));
    draftStore.update("new:p1", previous => ({ ...previous, attachments }));
    const before = draftStore.getSnapshot("new:p1");
    await addUnsentFile(image(attachments.length));
    expect(draftStore.getSnapshot("new:p1")).toBe(before);
    expect(read).not.toHaveBeenCalled();
  },
);

it("keeps mixed selection order and the separate non-image count limit", async () => {
  const upload = vi.spyOn(ApiClient.prototype, "uploadFile").mockResolvedValue(server);
  const { draftStore, addUnsentFile } = fixture();
  const images = Array.from({ length: IMAGE_LIMITS.maxCount }, (_, index) => image(index));
  const first = file();
  const second = new File(["second"], "second.txt", { type: "text/plain" });
  await Promise.all([first, ...images, image(images.length), second].map(addUnsentFile));
  expect(draftStore.getSnapshot("new:p1").attachments.map(item => item.name))
    .toEqual([first.name, ...images.map(item => item.name), second.name]);
  expect(draftStore.getSnapshot("new:p1").attachments.every(item => item.status === "ready")).toBe(true);
  await Promise.all(Array.from({ length: FILE_LIMITS.maxCount - 2 }, file).map(addUnsentFile));
  expect(upload).toHaveBeenCalledTimes(FILE_LIMITS.maxCount);
  await addUnsentFile(file());
  expect(draftStore.getSnapshot("new:p1").attachments.at(-1)).toMatchObject({ status: "error", error: "每条消息最多 5 个文件" });
  expect(upload).toHaveBeenCalledTimes(FILE_LIMITS.maxCount);
});

it("keeps size and format errors, but ignores an over-count image before its size check", async () => {
  const { draftStore, addUnsentFile } = fixture();
  const oversized = new File([new Uint8Array(IMAGE_LIMITS.maxEach + 1)], "large.png", { type: "image/png" });
  await addUnsentFile(oversized);
  expect(draftStore.getSnapshot("new:p1").attachments.at(-1)).toMatchObject({ status: "error", error: "单张图片不能超过 4 MiB" });
  await addUnsentFile(new File(["unsupported"], "unsupported.gif", { type: "image/gif" }));
  expect(draftStore.getSnapshot("new:p1").attachments.at(-1)).toMatchObject({ status: "error", error: "不支持该格式；压缩包与可执行文件不能上传" });
  await Promise.all(Array.from({ length: IMAGE_LIMITS.maxCount }, (_, index) => image(index)).map(addUnsentFile));
  const before = draftStore.getSnapshot("new:p1");
  await addUnsentFile(oversized);
  expect(draftStore.getSnapshot("new:p1")).toBe(before);
});

it("preserves an actual image read failure and its slot until removal", async () => {
  vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementationOnce(function (this: FileReader) {
    this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
  });
  const { draftStore, addUnsentFile, removeUnsentAttachment } = fixture();
  await addUnsentFile(image(0));
  const failed = draftStore.getSnapshot("new:p1").attachments[0]!;
  expect(failed).toMatchObject({ kind: "image", status: "error", error: "图片读取失败" });
  await Promise.all(Array.from({ length: IMAGE_LIMITS.maxCount }, (_, index) => image(index + 1)).map(addUnsentFile));
  expect(draftStore.getSnapshot("new:p1").attachments).toHaveLength(IMAGE_LIMITS.maxCount);
  expect(draftStore.getSnapshot("new:p1").attachments[0]).toBe(failed);
  removeUnsentAttachment(failed.localId);
  await addUnsentFile(image(IMAGE_LIMITS.maxCount + 1));
  expect(draftStore.getSnapshot("new:p1").attachments.every(item => item.status === "ready")).toBe(true);
});

it("finishes an upload in the migrated draft while retaining the original project", async () => {
  const { upload, resolve } = pendingUpload();
  const { draftStore, addUnsentFile, invalidateRestore } = fixture();
  const sending = addUnsentFile(file());
  await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
  const original = draftStore.getSnapshot("new:p1");
  draftStore.update("session:s1", () => ({ ...original, text: "edited" }));
  draftStore.update("new:p1", () => EMPTY_MESSAGE);
  resolve(server);
  await sending;
  expect(invalidateRestore).toHaveBeenCalledOnce();
  expect(upload.mock.calls[0]![0].projectId).toBe("p1");
  expect(draftStore.getSnapshot("new:p1")).toBe(EMPTY_MESSAGE);
  expect(draftStore.getSnapshot("session:s1")).toMatchObject({ text: "edited", attachments: [{ status: "ready", server }] });
});

it("does not resurrect a removed attachment when its upload finishes", async () => {
  const { upload, resolve } = pendingUpload();
  const { draftStore, addUnsentFile, removeUnsentAttachment } = fixture();
  const sending = addUnsentFile(file());
  await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
  removeUnsentAttachment(draftStore.getSnapshot("new:p1").attachments[0]!.localId);
  const removed = draftStore.getSnapshot("new:p1");
  resolve(server);
  await sending;
  expect(draftStore.getSnapshot("new:p1")).toBe(removed);
  expect(removed.attachments).toEqual([]);
});

it("keeps real upload failures retryable even when excess images were ignored", async () => {
  const upload = vi.spyOn(ApiClient.prototype, "uploadFile")
    .mockRejectedValueOnce(new ApiError(400, "rejected"))
    .mockResolvedValueOnce(server);
  const { draftStore, addUnsentFile, retryUnsentAttachment } = fixture();
  await Promise.all(Array.from({ length: IMAGE_LIMITS.maxCount + 1 }, (_, index) => image(index)).map(addUnsentFile));
  await addUnsentFile(file());
  const rejected = draftStore.getSnapshot("new:p1").attachments.at(-1)!;
  expect(rejected).toMatchObject({ status: "error", error: "rejected", file: expect.any(File) });
  await retryUnsentAttachment(rejected.localId);
  expect(upload.mock.calls[1]![0].uploadKey).toBe(upload.mock.calls[0]![0].uploadKey);
  expect(draftStore.getSnapshot("new:p1").attachments.at(-1)).toMatchObject({ status: "ready", server, file: undefined, error: undefined });
});

it("retries a known failure with the same upload key; network interruption drops the file", async () => {
  const upload = vi.spyOn(ApiClient.prototype, "uploadFile")
    .mockRejectedValueOnce(new ApiError(400, "rejected"))
    .mockRejectedValueOnce(new Error("network"));
  const { draftStore, addUnsentFile, retryUnsentAttachment } = fixture();
  await addUnsentFile(file());
  const rejected = draftStore.getSnapshot("new:p1").attachments[0]!;
  expect(rejected).toMatchObject({ status: "error", error: "rejected" });
  expect(rejected.file).toBeDefined();
  await retryUnsentAttachment(rejected.localId);
  expect(upload.mock.calls[1]![0].uploadKey).toBe(upload.mock.calls[0]![0].uploadKey);
  expect(draftStore.getSnapshot("new:p1").attachments[0]).toMatchObject({ status: "interrupted", file: undefined });
  await retryUnsentAttachment(rejected.localId);
  expect(upload).toHaveBeenCalledTimes(2);
});
