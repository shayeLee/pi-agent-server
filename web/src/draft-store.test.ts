import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "./draft-store.js";
import { EMPTY_MESSAGE } from "./attachment-state.js";

describe("page-local draft subscriptions", () => {
  it("notifies only the changed scope and keeps snapshots stable until updated", () => {
    const store = createDraftStore();
    const a = vi.fn(), b = vi.fn();
    const unsubscribe = store.subscribe("session:a", a);
    store.subscribe("new:project", b);
    expect(store.getSnapshot("session:a")).toBe(EMPTY_MESSAGE);
    store.update("session:a", previous => ({ ...previous, text: "typing" }));
    const snapshot = store.getSnapshot("session:a");
    expect(store.getSnapshot("session:a")).toBe(snapshot);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    store.update("new:project", previous => ({ ...previous, text: "new draft" }));
    expect(store.getSnapshot("session:a")).toBe(snapshot);
    unsubscribe();
    store.update("session:a", previous => ({ ...previous, text: "later" }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(store.getAll()["new:project"].text).toBe("new draft");
  });
});
