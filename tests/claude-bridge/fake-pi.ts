// An in-memory pi-agent-server for bridge tests: just the routes the bridge calls.
import type { Export, SessionRecord, SseEvent } from "../../src/client/index.js";

type Reply = { status: number; body?: unknown };
type Stream = { sessionId: string; controller: ReadableStreamDefaultController<Uint8Array> };

export class FakePi {
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  readonly sessions: SessionRecord[] = [];
  readonly timelines = new Map<string, Export["timeline"]>();
  access = { canRead: true, canWrite: true };
  models = {
    models: [{ provider: "openai", id: "gpt-6-luna", name: "Luna" }],
    thinkingLevels: ["off", "low", "medium", "high"],
    defaultModel: { provider: "openai", id: "gpt-6-luna", name: "Luna" },
    defaultThinkingLevel: "medium",
    modelThinkingLevels: {},
  };
  /** Decides the answer to POST /messages; defaults to accepted. */
  onMessage: (sessionId: string, body: { requestId: string; prompt: string }) => Reply = () => ({ status: 202, body: { status: "accepted" } });
  onSteer: () => Reply = () => ({ status: 204 });
  onAbort: () => Reply = () => ({ status: 204 });
  epoch = "epoch-1";
  private eventId = 0;
  private readonly streams = new Set<Stream>();
  private readonly encoder = new TextEncoder();
  private nextSession = 1;

  addSession(partial: Partial<SessionRecord> = {}): SessionRecord {
    const session: SessionRecord = {
      id: `s${this.nextSession++}`, ownerKey: "127.0.0.1", projectId: "p1", title: "",
      createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null,
      ...partial,
    };
    this.sessions.push(session);
    this.timelines.set(session.id, []);
    return session;
  }

  /** Push an SSE event to every open stream of the session. */
  emit(sessionId: string, event: SseEvent): void {
    const id = ++this.eventId;
    const frame = this.encoder.encode(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const stream of this.streams) if (stream.sessionId === sessionId) stream.controller.enqueue(frame);
  }

  /** End every open stream of the session, as a server restart would. */
  closeStreams(sessionId: string): void {
    for (const stream of [...this.streams]) {
      if (stream.sessionId !== sessionId) continue;
      this.streams.delete(stream);
      stream.controller.close();
    }
  }

  openStreams(sessionId: string): number {
    return [...this.streams].filter((s) => s.sessionId === sessionId).length;
  }

  /** Add an exported message to the session's timeline. */
  say(sessionId: string, role: "user" | "assistant", text: string): void {
    const timeline = this.timelines.get(sessionId)!;
    timeline.push({ id: `m${timeline.length}`, type: "message", role, messageId: `m${timeline.length}`, turnId: null, text, order: timeline.length });
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: url.pathname + url.search, ...(body !== undefined ? { body } : {}) });
    const reply = this.route(method, url, body, init.signal ?? undefined);
    if (reply instanceof Response) return reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };

  private route(method: string, url: URL, body: unknown, signal?: AbortSignal): Reply | Response {
    const path = url.pathname;
    const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)(\/.*)?$/);
    if (method === "GET" && path === "/v1/access") return { status: 200, body: this.access };
    if (method === "GET" && path === "/v1/projects") {
      return { status: 200, body: [
        { id: "p1", name: "one", cwd: "/tmp/one", isDefault: true },
        { id: "p2", name: "two", cwd: "/tmp/two", isDefault: false },
      ] };
    }
    if (method === "GET" && path === "/v1/models") return { status: 200, body: this.models };
    if (method === "GET" && path === "/v1/sessions") {
      const projectId = url.searchParams.get("projectId");
      return { status: 200, body: this.sessions.filter((s) => projectId === null || s.projectId === projectId) };
    }
    if (method === "POST" && path === "/v1/sessions") {
      const input = body as { title?: string; projectId?: string };
      return { status: 201, body: this.addSession({ title: input.title ?? "", projectId: input.projectId ?? "p1" }) };
    }
    if (!sessionMatch) return { status: 404 };
    const session = this.sessions.find((s) => s.id === sessionMatch[1]);
    if (!session) return { status: 404 };
    switch (`${method} ${sessionMatch[2] ?? ""}`) {
      case "PATCH /config":
        Object.assign(session, body);
        return { status: 200, body: session };
      case "GET /export":
        return { status: 200, body: { messages: [], timeline: this.timelines.get(session.id), lastEventId: this.eventId } };
      case "POST /messages":
        return this.onMessage(session.id, body as { requestId: string; prompt: string });
      case "POST /steer":
        return this.onSteer();
      case "POST /abort":
        return this.onAbort();
      case "GET /events":
        return this.openStream(session.id, signal);
      default:
        return { status: 404 };
    }
  }

  private openStream(sessionId: string, signal?: AbortSignal): Response {
    let entry: Stream;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        entry = { sessionId, controller };
        this.streams.add(entry);
        signal?.addEventListener("abort", () => {
          this.streams.delete(entry);
          try { controller.close(); } catch { /* already closed */ }
        }, { once: true });
      },
      cancel: () => { this.streams.delete(entry); },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-server-epoch": this.epoch } });
  }
}
