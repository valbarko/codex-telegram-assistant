import type { ExecutionProfile, AppConfiguration } from "./configuration.js";
import { AppServerTransport, type RpcRecord } from "./appserver-transport.js";

export type AssistantInput = string | { text?: string; images?: readonly string[]; fileNote?: string };
export type ApprovalChoice = "accept" | "acceptForSession" | "decline" | "cancel";

export interface ApprovalPrompt {
  category: "command" | "files" | "permissions";
  itemId: string;
  command?: string;
  directory?: string;
  reason?: string;
  root?: string;
}

export interface UserInputOption { label: string; description: string; }
export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: readonly UserInputOption[];
}
export interface UserInputPrompt {
  questions: readonly UserInputQuestion[];
  autoResolutionMs?: number;
}
export type UserInputAnswers = Record<string, { answers: string[] }>;

export interface TurnObserver {
  text(delta: string): void;
  toolStarted(id: string, label: string): void;
  toolProgress(id: string, delta: string): void;
  toolFinished(id: string, failed: boolean): void;
  plan?(steps: readonly { text: string; done: boolean }[]): void;
  usage?(last: TokenCount, total: TokenCount): void;
  approval?(prompt: ApprovalPrompt): Promise<ApprovalChoice>;
  userInput?(prompt: UserInputPrompt): Promise<UserInputAnswers>;
}

export interface TokenCount {
  input: number;
  cached: number;
  output: number;
}

export interface ConversationSnapshot {
  threadId?: string;
  workspace: string;
  model?: string;
  effort?: string;
  profileId: string;
  running: boolean;
  tokens: TokenCount;
}

export interface StoredThread {
  id: string;
  title: string;
  workspace: string;
  model?: string;
  updatedAt: number;
  archived: boolean;
}

interface ThreadOpenResult {
  thread: { id: string };
  cwd?: string;
  model?: string;
  reasoningEffort?: string | null;
}

interface TurnOpenResult {
  turn: { id: string };
}

export class CodexHub {
  private readonly conversations = new Map<string, Conversation>();

  constructor(
    private readonly configuration: AppConfiguration,
    readonly transport = new AppServerTransport(),
  ) {}

  async conversation(context: string, saved?: Partial<ConversationSnapshot>): Promise<Conversation> {
    const existing = this.conversations.get(context);
    if (existing) return existing;
    await this.transport.connect();
    const created = new Conversation(this.transport, this.configuration, saved);
    if (saved?.threadId) await created.resume(saved.threadId);
    this.conversations.set(context, created);
    return created;
  }

  get(context: string): Conversation | undefined {
    return this.conversations.get(context);
  }

  remove(context: string): void {
    this.conversations.get(context)?.release();
    this.conversations.delete(context);
  }

  async threads(limit = 50, query?: string): Promise<StoredThread[]> {
    const response = await this.transport.call<{ data?: unknown[] }>("thread/list", {
      limit, archived: false, searchTerm: query || null, sortKey: "updated_at", sortDirection: "desc",
    });
    return (response.data ?? []).map(readStoredThread).filter((thread): thread is StoredThread => thread !== null);
  }

  async archive(threadId: string): Promise<void> {
    await this.transport.call("thread/archive", { threadId });
  }

  async rename(threadId: string, name: string): Promise<void> {
    await this.transport.call("thread/name/set", { threadId, name });
  }

  async fork(threadId: string): Promise<string> {
    const response = await this.transport.call<{ thread: { id: string } }>("thread/fork", { threadId });
    return response.thread.id;
  }

  shutdown(): void {
    for (const conversation of this.conversations.values()) conversation.release();
    this.conversations.clear();
    this.transport.close();
  }
}

export class Conversation {
  private threadId?: string;
  private workspace: string;
  private model?: string;
  private effort?: string;
  private profileId: string;
  private turnId?: string;
  private tokens: TokenCount = { input: 0, cached: 0, output: 0 };

  constructor(
    private readonly transport: AppServerTransport,
    private readonly configuration: AppConfiguration,
    saved?: Partial<ConversationSnapshot>,
  ) {
    this.threadId = saved?.threadId;
    this.workspace = saved?.workspace || configuration.defaultWorkspace;
    this.model = saved?.model || configuration.defaultModel;
    this.effort = saved?.effort;
    this.profileId = saved?.profileId || configuration.defaultProfile;
  }

  snapshot(): ConversationSnapshot {
    return {
      threadId: this.threadId,
      workspace: this.workspace,
      model: this.model,
      effort: this.effort,
      profileId: this.profileId,
      running: Boolean(this.turnId),
      tokens: { ...this.tokens },
    };
  }

  selectProfile(id: string): ExecutionProfile {
    const profile = this.configuration.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    this.profileId = id;
    return profile;
  }

  selectModel(model: string): void {
    this.model = model;
  }

  selectEffort(effort: string): void {
    this.effort = effort;
  }

  async start(workspace = this.workspace): Promise<ConversationSnapshot> {
    this.ensureIdle();
    const profile = this.profile();
    const result = await this.transport.call<ThreadOpenResult>("thread/start", {
      cwd: workspace,
      model: this.model ?? null,
      sandbox: profile.sandbox,
      approvalPolicy: profile.approvals,
      approvalsReviewer: "user",
      ephemeral: false,
      threadSource: "codexTelegramAssistant",
    });
    this.threadId = result.thread.id;
    this.workspace = result.cwd || workspace;
    this.model = result.model || this.model;
    this.effort = result.reasoningEffort || this.effort;
    return this.snapshot();
  }

  async resume(threadId: string): Promise<ConversationSnapshot> {
    this.ensureIdle();
    const profile = this.profile();
    const result = await this.transport.call<ThreadOpenResult>("thread/resume", {
      threadId,
      cwd: this.workspace,
      model: this.model ?? null,
      sandbox: profile.sandbox,
      approvalPolicy: profile.approvals,
      approvalsReviewer: "user",
    });
    this.threadId = result.thread.id || threadId;
    this.workspace = result.cwd || this.workspace;
    this.model = result.model || this.model;
    this.effort = result.reasoningEffort || this.effort;
    return this.snapshot();
  }

  async run(input: AssistantInput, observer: TurnObserver): Promise<void> {
    if (!this.threadId) await this.start();
    if (this.turnId) throw new Error("A turn is already running");
    const threadId = this.threadId!;
    const profile = this.profile();
    let complete!: () => void;
    let fail!: (error: Error) => void;
    let finished = false;
    const result = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    const outputs = new Map<string, string>();
    const settle = (error?: Error): void => {
      if (finished) return;
      finished = true;
      error ? fail(error) : complete();
    };
    const stopListening = this.transport.listen((name, payload) => {
      if (name === "transport/disconnected") return settle(new Error(text(payload, "message") || "app-server disconnected"));
      if (payload.threadId !== threadId) return;
      const eventTurn = text(payload, "turnId") || text(record(payload.turn), "id");
      if (this.turnId && eventTurn && eventTurn !== this.turnId) return;
      if (name === "turn/started" && eventTurn) this.turnId = eventTurn;
      else if (name === "item/agentMessage/delta") observer.text(text(payload, "delta"));
      else if (name === "item/started") started(record(payload.item), observer);
      else if (name === "item/commandExecution/outputDelta") progress(payload, observer, outputs);
      else if (name === "item/mcpToolCall/progress") observer.toolProgress(text(payload, "itemId"), text(payload, "message"));
      else if (name === "item/completed") completed(record(payload.item), observer, outputs);
      else if (name === "turn/plan/updated") observer.plan?.(readPlan(payload.plan));
      else if (name === "thread/tokenUsage/updated") {
        const usage = record(payload.tokenUsage);
        const total = readTokens(record(usage.total));
        const last = readTokens(record(usage.last));
        this.tokens = total;
        observer.usage?.(last, total);
      } else if (name === "error" && payload.willRetry !== true) {
        settle(new Error(text(record(payload.error), "message") || "Codex failed"));
      } else if (name === "turn/completed") {
        const turn = record(payload.turn);
        const status = text(turn, "status");
        settle(status === "failed" ? new Error(text(record(turn.error), "message") || "Codex turn failed") : undefined);
      }
    });
    this.transport.answerRequestsFor(threadId, (name, payload) => this.answerHostRequest(name, payload, observer));
    try {
      const opened = await this.transport.call<TurnOpenResult>("turn/start", {
        threadId,
        input: toProtocolInput(input),
        cwd: this.workspace,
        model: this.model ?? null,
        effort: this.effort ?? null,
        approvalPolicy: profile.approvals,
        approvalsReviewer: "user",
      });
      this.turnId = opened.turn.id;
      await result;
    } finally {
      stopListening();
      this.transport.answerRequestsFor(threadId);
      this.turnId = undefined;
    }
  }

  async steer(input: AssistantInput): Promise<void> {
    if (!this.threadId || !this.turnId) throw new Error("No active turn");
    await this.transport.call("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: toProtocolInput(input) });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    await this.transport.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }

  release(): void {
    if (this.turnId) void this.interrupt();
    if (this.threadId) void this.transport.call("thread/unsubscribe", { threadId: this.threadId }).catch(() => undefined);
    this.turnId = undefined;
    this.threadId = undefined;
  }

  private profile(): ExecutionProfile {
    return this.configuration.profiles.find((candidate) => candidate.id === this.profileId)
      ?? this.configuration.profiles[0]!;
  }

  private ensureIdle(): void {
    if (this.turnId) throw new Error("Cannot switch thread during a running turn");
  }

  private async answerHostRequest(name: string, payload: RpcRecord, observer: TurnObserver): Promise<unknown> {
    if (name === "item/tool/requestUserInput") {
      const prompt = readUserInput(payload);
      return { answers: observer.userInput ? await observer.userInput(prompt) : {} };
    }
    const requested = approvalFrom(name, payload);
    if (!requested) throw new Error(`Unsupported host request: ${name}`);
    const choice = observer.approval ? await observer.approval(requested) : "decline";
    if (name === "item/permissions/requestApproval") {
      const permissions = record(payload.permissions);
      return {
        permissions: choice === "accept" || choice === "acceptForSession" ? compactPermissions(permissions) : {},
        scope: choice === "acceptForSession" ? "session" : "turn",
      };
    }
    return { decision: choice };
  }
}

function readUserInput(payload: RpcRecord): UserInputPrompt {
  const questions = (Array.isArray(payload.questions) ? payload.questions : []).map((value): UserInputQuestion | null => {
    const question = record(value);
    const id = text(question, "id");
    if (!id) return null;
    const options = Array.isArray(question.options) ? question.options.map((option) => {
      const item = record(option);
      return { label: text(item, "label"), description: text(item, "description") };
    }).filter((option) => option.label) : undefined;
    return {
      id, header: text(question, "header"), question: text(question, "question"),
      isOther: question.isOther === true, isSecret: question.isSecret === true, options,
    };
  }).filter((question): question is UserInputQuestion => question !== null);
  return { questions, autoResolutionMs: typeof payload.autoResolutionMs === "number" ? payload.autoResolutionMs : undefined };
}

function toProtocolInput(input: AssistantInput): RpcRecord[] {
  if (typeof input === "string") return [{ type: "text", text: input, text_elements: [] }];
  const result: RpcRecord[] = [];
  const words = [input.fileNote, input.text].filter(Boolean).join("\n\n");
  if (words) result.push({ type: "text", text: words, text_elements: [] });
  for (const image of input.images ?? []) result.push({ type: "localImage", path: image });
  return result.length ? result : [{ type: "text", text: "", text_elements: [] }];
}

function started(item: RpcRecord, observer: TurnObserver): void {
  const id = text(item, "id");
  if (item.type === "commandExecution") observer.toolStarted(id, text(item, "command") || "command");
  else if (item.type === "mcpToolCall") observer.toolStarted(id, `mcp:${text(item, "server")}/${text(item, "tool")}`);
  else if (item.type === "dynamicToolCall") observer.toolStarted(id, text(item, "tool") || "tool");
  else if (item.type === "webSearch") observer.toolStarted(id, "web search");
}

function progress(payload: RpcRecord, observer: TurnObserver, outputs: Map<string, string>): void {
  const id = text(payload, "itemId");
  const delta = text(payload, "delta");
  if (!id || !delta) return;
  outputs.set(id, `${outputs.get(id) ?? ""}${delta}`);
  observer.toolProgress(id, delta);
}

function completed(item: RpcRecord, observer: TurnObserver, outputs: Map<string, string>): void {
  const id = text(item, "id");
  if (item.type === "commandExecution") {
    const aggregate = text(item, "aggregatedOutput");
    const previous = outputs.get(id) ?? "";
    if (aggregate && aggregate !== previous) observer.toolProgress(id, aggregate.startsWith(previous) ? aggregate.slice(previous.length) : aggregate);
    observer.toolFinished(id, item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0));
  } else if (item.type === "fileChange") {
    observer.toolStarted(id, "file changes");
    observer.toolProgress(id, (Array.isArray(item.changes) ? item.changes : []).map((entry) => {
      const change = record(entry);
      return [text(change, "kind"), text(change, "path")].filter(Boolean).join(" ");
    }).join(", "));
    observer.toolFinished(id, item.status === "failed");
  } else if (["mcpToolCall", "dynamicToolCall", "webSearch"].includes(String(item.type))) {
    observer.toolFinished(id, item.status === "failed" || item.success === false);
  }
}

function approvalFrom(name: string, payload: RpcRecord): ApprovalPrompt | null {
  const base = { itemId: text(payload, "itemId") || "approval", reason: text(payload, "reason") || undefined };
  if (name === "item/commandExecution/requestApproval") return { ...base, category: "command", command: text(payload, "command") || undefined, directory: text(payload, "cwd") || undefined };
  if (name === "item/fileChange/requestApproval") return { ...base, category: "files", root: text(payload, "grantRoot") || undefined };
  if (name === "item/permissions/requestApproval") return { ...base, category: "permissions", directory: text(payload, "cwd") || undefined };
  return null;
}

function compactPermissions(requested: RpcRecord): RpcRecord {
  const result: RpcRecord = {};
  if (requested.network) result.network = requested.network;
  if (requested.fileSystem) result.fileSystem = requested.fileSystem;
  return result;
}

function readTokens(value: RpcRecord): TokenCount {
  return { input: number(value.inputTokens), cached: number(value.cachedInputTokens), output: number(value.outputTokens) };
}

function readPlan(value: unknown): readonly { text: string; done: boolean }[] {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const step = record(entry);
    return { text: text(step, "step") || "Step", done: step.status === "completed" };
  });
}

function readStoredThread(value: unknown): StoredThread | null {
  const item = record(value);
  const id = text(item, "id");
  if (!id) return null;
  return {
    id,
    title: text(item, "name") || text(item, "preview") || "Untitled",
    workspace: text(item, "cwd"),
    model: text(item, "model") || undefined,
    updatedAt: 1000 * number(item.updatedAt),
    archived: item.archived === true,
  };
}

function record(value: unknown): RpcRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : {};
}

function text(value: RpcRecord, key: string): string {
  return typeof value[key] === "string" ? value[key] as string : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
