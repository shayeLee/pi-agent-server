/**
 * The blank session companion's opening line, written by a model (DESIGN.md §6.6). The model
 * only ever sees facts the caller may already read: the project's name, the names of its
 * templates and skills, the time of day and the title of the caller's latest session. It is
 * a nicety, so every failure is the caller's cue to fall back to its local lines.
 */
export type CompanionStyle = "concise" | "lively" | "formal";
export type DayPart = "dawn" | "morning" | "noon" | "afternoon" | "evening" | "night";

export type CompanionGreetingInput = {
  ownerKey: string;
  projectId: string;
  projectName: string;
  persona: { name: string; style: CompanionStyle };
  dayPart: DayPart;
  recent: { title: string; minutesAgo: number } | null;
  commands: readonly { name: string; description?: string }[];
};
export type CompanionGreeting = { greeting: string; hint: string };

/** One short, tool-free completion: system prompt and user text in, the reply's text out. */
export type CompanionCompletion = (input: { systemPrompt: string; prompt: string; signal: AbortSignal }) => Promise<string>;

export class CompanionGreetingError extends Error {}

const MAX_GREETING = 40;
const MAX_HINT = 60;
const COMMAND_LIMIT = 8;
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const CACHE_LIMIT = 200;

const DAY_PARTS: Record<DayPart, string> = { dawn: "清晨", morning: "上午", noon: "中午", afternoon: "下午", evening: "傍晚到晚上", night: "深夜" };
const VOICES: Record<CompanionStyle, string> = {
  concise: "简洁、干脆，像靠谱的同事，不用语气词和颜文字",
  lively: "活泼、俏皮，像一只亲人的小猫，可以用“呀”“～”这类语气词，但不要颜文字或 emoji",
  formal: "礼貌、正式，用“您”，措辞稳重",
};

/** Lines are spoken in the UI as-is: one line each, no markup, no quotes around them. */
function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/[`*]/g, "").replace(/\s+/g, " ").trim().replace(/^["“'「]+|["”'」]+$/g, "");
  if (!line || line.length > max || /[<>#\[\]]/.test(line)) return null;
  return line;
}

/** Accepts the JSON object alone or wrapped in a fence or a sentence; anything else is a failure. */
export function parseGreeting(text: string): CompanionGreeting {
  const match = /\{[\s\S]*\}/.exec(text);
  let parsed: unknown;
  try { parsed = match ? JSON.parse(match[0]) : null; } catch { parsed = null; }
  const raw = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const greeting = clean(raw.greeting, MAX_GREETING);
  const hint = clean(raw.hint, MAX_HINT);
  if (!greeting || !hint) throw new CompanionGreetingError("模型返回的开场白不可用");
  return { greeting, hint };
}

export function greetingPrompt(input: CompanionGreetingInput): { systemPrompt: string; prompt: string } {
  const systemPrompt = [
    `你是编程助手 PI 工作台里的吉祥物「${input.persona.name}」，一只线描小猫，坐在输入框上陪伴用户。`,
    `说话风格：${VOICES[input.persona.style]}。`,
    "用户刚打开一个空白会话。请用简体中文写两句话：",
    `- greeting：打招呼并提到项目名，不超过 ${MAX_GREETING} 个字；名字已显示在你头顶，不要自我介绍；`,
    `- hint：一个具体、可执行的起步建议，不超过 ${MAX_HINT} 个字。只能依据下面给出的信息，不要编造文件、功能或进度。`,
    "只输出一个 JSON 对象：{\"greeting\": \"…\", \"hint\": \"…\"}，不要输出其他内容。",
  ].join("\n");
  const facts = [
    `项目名：${input.projectName}`,
    `时段：${DAY_PARTS[input.dayPart]}`,
    input.recent
      ? `用户在这个项目里最近的会话：「${input.recent.title || "未命名"}」，${input.recent.minutesAgo} 分钟前`
      : "用户在这个项目里还没有会话",
    input.commands.length
      ? `可用的模板和 skill（输入 / 选择）：${input.commands.slice(0, COMMAND_LIMIT).map(command => command.description ? `/${command.name}（${command.description.slice(0, 40)}）` : `/${command.name}`).join("；")}`
      : "这个项目没有模板或 skill",
    "用户可以输入 @ 引用项目里的文件。",
  ];
  return { systemPrompt, prompt: facts.join("\n") };
}

/** Bucket the recency so a reload a minute later still hits the cache. */
function recencyBucket(minutes: number): string {
  if (minutes < 60) return "m";
  if (minutes < 24 * 60) return `h${Math.floor(minutes / 60)}`;
  return `d${Math.floor(minutes / (24 * 60))}`;
}

/**
 * Caches per caller and per everything the line depends on, and shares one request among
 * concurrent callers, so opening the same blank page again costs nothing.
 */
export class CompanionGreeter {
  private readonly cache = new Map<string, { at: number; value: CompanionGreeting }>();
  private readonly inflight = new Map<string, Promise<CompanionGreeting>>();

  constructor(private readonly options: {
    complete: CompanionCompletion;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
  }) {}

  async greet(input: CompanionGreetingInput): Promise<CompanionGreeting> {
    const key = JSON.stringify([input.ownerKey, input.projectId, input.projectName, input.persona.name, input.persona.style, input.dayPart,
      input.recent ? [input.recent.title, recencyBucket(input.recent.minutesAgo)] : null, input.commands.slice(0, COMMAND_LIMIT).map(command => command.name)]);
    const now = this.options.now ?? Date.now;
    const hit = this.cache.get(key);
    if (hit && now() - hit.at < (this.options.ttlMs ?? DEFAULT_TTL_MS)) return hit.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const request = this.generate(input).then(value => {
      this.cache.delete(key);
      this.cache.set(key, { at: now(), value });
      while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private async generate(input: CompanionGreetingInput): Promise<CompanionGreeting> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return parseGreeting(await this.options.complete({ ...greetingPrompt(input), signal }));
  }
}
